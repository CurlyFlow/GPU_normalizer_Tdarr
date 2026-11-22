#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ast
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path
from audio_clock_artifact import ARTIFACT as CLOCK_ARTIFACT, build_audio_clock, publish_build_manifest
from aac_encode_artifact import ARTIFACT as AAC_MT_ARTIFACT, build_aac_encode_mt


REPO_ROOT = Path(__file__).resolve().parents[1]
PTX_SOURCE = Path('runtime/cuda/loudnorm_source_port_kernels.cu')
PTX_ARTIFACT = Path('runtime/cuda/loudnorm_source_port_kernels.ptx')
PTX_COMPILER = Path('runtime/cuda/compile_cuda_ptx.py')
NATIVE_SOURCE = Path('runtime/bin/opx_loudnorm_channel_stats.c')
NATIVE_ARTIFACT = Path('runtime/bin/opx_loudnorm_channel_stats.so')
ARTIFACT_LOCK = REPO_ROOT / 'work/locks/runtime-artifacts.lock'
PTX_ENTRY_PATTERN = re.compile(r'(?m)^\s*(?:\.visible\s+)?\.entry\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(')

KERNEL_SYMBOL_PROBE = '''
import json
import sys

sys.path.insert(0, sys.argv[1])
from cuda_kernel_manifest import CUDA_KERNEL_SYMBOLS

print(json.dumps(list(CUDA_KERNEL_SYMBOLS)))
'''

NATIVE_ABI_PROBE = '''
import os
import sys

runtime_bin, native_path, *symbols = sys.argv[1:]
sys.path.insert(0, runtime_bin)
os.environ['LOUDNORM_GPU_CHANNEL_STATS_NATIVE_LIB'] = native_path

import stats_channel_native

stats_channel_native._NATIVE_LIB = None
lib = stats_channel_native._load_native_lib()
for symbol in symbols:
    getattr(lib, symbol)
print(f'native_symbols={len(symbols)}')
'''


def fail(message: str) -> None:
    print(f'ERR: {message}', file=sys.stderr)
    raise SystemExit(1)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def require_file(path: Path) -> None:
    if not path.is_file():
        fail(f'required runtime artifact input is missing: {path}')


def nvrtc_environment() -> dict[str, str]:
    env = os.environ.copy()
    local_nvrtc = REPO_ROOT / 'work/tools/nvrtc/nvidia/cuda_nvrtc/lib/libnvrtc.so.12'
    if not env.get('NVRTC_LIB') and local_nvrtc.is_file():
        lib_dir = str(local_nvrtc.parent)
        env['NVRTC_LIB'] = str(local_nvrtc)
        env['LD_LIBRARY_PATH'] = lib_dir + (f':{env["LD_LIBRARY_PATH"]}' if env.get('LD_LIBRARY_PATH') else '')
    return env


def normalize_ptx(path: Path) -> None:
    lines = path.read_bytes().splitlines()
    path.write_bytes(b'\n'.join(line.rstrip(b' \t') for line in lines) + b'\n')


def temp_path_for(target: Path) -> Path:
    fd, raw_path = tempfile.mkstemp(prefix=f'.{target.name}.', dir=target.parent)
    os.close(fd)
    return Path(raw_path)


@contextmanager
def artifact_lock():
    ARTIFACT_LOCK.parent.mkdir(parents=True, exist_ok=True)
    with ARTIFACT_LOCK.open('a+', encoding='utf-8') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def clean_stale(plugin_root: Path) -> None:
    removed = []
    for relative in (PTX_ARTIFACT, NATIVE_ARTIFACT, CLOCK_ARTIFACT, AAC_MT_ARTIFACT):
        target = plugin_root / relative
        for path in sorted(target.parent.glob(f'.{target.name}.*')):
            if path.is_file():
                path.unlink()
                removed.append(path.relative_to(plugin_root).as_posix())
    print(f'OK: stale runtime artifact cleanup removed={len(removed)}')
    for path in removed:
        print(f'REMOVED: {path}')


def build_ptx(plugin_root: Path, output: Path) -> None:
    subprocess.run(
        [
            sys.executable,
            str(plugin_root / PTX_COMPILER),
            str(plugin_root / PTX_SOURCE),
            str(output),
        ],
        check=True,
        env=nvrtc_environment(),
    )
    normalize_ptx(output)


def native_compiler() -> list[str]:
    compiler = shlex.split(os.environ.get('CC', 'cc'))
    if not compiler:
        fail('CC resolved to an empty compiler command')
    try:
        version = subprocess.check_output([*compiler, '--version'], text=True).splitlines()[0]
    except (OSError, subprocess.CalledProcessError, IndexError) as exc:
        fail(f'unable to inspect native compiler {compiler[0]!r}: {exc}')
    print(f'native_cc={version}')
    return compiler


def build_native(plugin_root: Path, output: Path) -> None:
    subprocess.run(
        [
            *native_compiler(),
            '-O3',
            '-fPIC',
            '-shared',
            '-pthread',
            str(plugin_root / NATIVE_SOURCE),
            '-o',
            str(output),
            '-lm',
        ],
        check=True,
    )


def run_python_probe(script: str, args: list[str], label: str) -> str:
    result = subprocess.run(
        [sys.executable, '-c', script, *args],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip() or 'no diagnostic output'
        fail(f'{label} failed with exit code {result.returncode}: {detail}')
    return result.stdout.strip()


def runtime_native_symbols(plugin_root: Path) -> tuple[str, ...]:
    symbols = set()
    runtime_bin = plugin_root / 'runtime/bin'
    for source_path in sorted(runtime_bin.glob('*.py')):
        module = ast.parse(source_path.read_text(), filename=str(source_path))
        symbols.update(
            node.attr
            for node in ast.walk(module)
            if isinstance(node, ast.Attribute) and node.attr.startswith('opx_loudnorm_')
        )
    if not symbols:
        fail(f'native runtime references no opx_loudnorm symbols under {runtime_bin}')
    return tuple(sorted(symbols))


def validate_native_abi(plugin_root: Path, artifact: Path, label: str) -> None:
    symbols = runtime_native_symbols(plugin_root)
    output = run_python_probe(
        NATIVE_ABI_PROBE,
        [str(plugin_root / 'runtime/bin'), str(artifact.resolve()), *symbols],
        f'{label} native ABI load',
    )
    print(f'OK: {label} native ABI load {output}')


def runtime_ptx_symbols(plugin_root: Path) -> tuple[str, ...]:
    output = run_python_probe(
        KERNEL_SYMBOL_PROBE,
        [str(plugin_root / 'runtime/bin')],
        'CUDA kernel manifest load',
    )
    try:
        symbols = tuple(json.loads(output))
    except (json.JSONDecodeError, TypeError) as exc:
        fail(f'CUDA kernel manifest returned invalid symbol JSON: {exc}')
    if not symbols or any(not isinstance(symbol, str) or not symbol for symbol in symbols):
        fail('CUDA kernel manifest returned an empty or invalid symbol list')
    if len(set(symbols)) != len(symbols):
        fail('CUDA kernel manifest contains duplicate symbols')
    return symbols


def validate_ptx_symbols(plugin_root: Path, artifact: Path, label: str) -> None:
    expected = runtime_ptx_symbols(plugin_root)
    actual = tuple(PTX_ENTRY_PATTERN.findall(artifact.read_text()))
    duplicate = sorted({symbol for symbol in actual if actual.count(symbol) > 1})
    missing = sorted(set(expected) - set(actual))
    errors = []
    if duplicate:
        errors.append('duplicate entries: ' + ', '.join(duplicate))
    if missing:
        errors.append('missing entries: ' + ', '.join(missing))
    if errors:
        fail(f'{label} PTX symbol validation failed: ' + '; '.join(errors))
    extra_count = len(set(actual) - set(expected))
    print(f'OK: {label} PTX symbols={len(actual)} required={len(expected)} extra={extra_count}')


def validate_artifact_abi(plugin_root: Path, ptx_artifact: Path, native_artifact: Path, label: str) -> None:
    validate_ptx_symbols(plugin_root, ptx_artifact, label)
    validate_native_abi(plugin_root, native_artifact, label)


def validate_inputs(plugin_root: Path) -> None:
    for rel in (
        PTX_SOURCE,
        PTX_COMPILER,
        NATIVE_SOURCE,
        Path('runtime/bin/audio_clock_mux.c'),
        Path('runtime/bin/aac_encode_mt.c'),
        Path('runtime/bin/aacenc_mt.h'),
    ):
        require_file(plugin_root / rel)


def build(plugin_root: Path) -> None:
    validate_inputs(plugin_root)
    ptx_target = plugin_root / PTX_ARTIFACT
    native_target = plugin_root / NATIVE_ARTIFACT
    ptx_temp = temp_path_for(ptx_target)
    native_temp = temp_path_for(native_target)
    clock_target = plugin_root / CLOCK_ARTIFACT
    clock_temp = temp_path_for(clock_target)
    aac_target = plugin_root / AAC_MT_ARTIFACT
    aac_temp = temp_path_for(aac_target)
    try:
        build_ptx(plugin_root, ptx_temp)
        build_native(plugin_root, native_temp)
        clock_proof = build_audio_clock(plugin_root, clock_temp, native_compiler())
        build_aac_encode_mt(plugin_root, aac_temp, native_compiler())
        ptx_temp.chmod(0o644)
        native_temp.chmod(0o755)
        validate_artifact_abi(plugin_root, ptx_temp, native_temp, 'rebuilt')
        os.replace(ptx_temp, ptx_target)
        os.replace(native_temp, native_target)
        os.replace(clock_temp, clock_target)
        os.replace(aac_temp, aac_target)
        manifest = publish_build_manifest(clock_proof, clock_target)
    finally:
        ptx_temp.unlink(missing_ok=True)
        native_temp.unlink(missing_ok=True)
        clock_temp.unlink(missing_ok=True)
        aac_temp.unlink(missing_ok=True)
    print(f'OK: built PTX sha256={sha256(ptx_target)}')
    print(f'OK: built native runtime sha256={sha256(native_target)}')
    print(f'OK: built audio clock carrier sha256={sha256(clock_target)}')
    print(f'OK: built multi-channel AAC encoder sha256={sha256(aac_target)}')
    print(f'OK: audio clock build proof={manifest}')


def assert_matches(expected: Path, rebuilt: Path, label: str) -> None:
    expected_hash = sha256(expected)
    rebuilt_hash = sha256(rebuilt)
    if expected_hash != rebuilt_hash or expected.read_bytes() != rebuilt.read_bytes():
        fail(
            f'{label} artifact does not match its deterministic rebuild: '
            f'expected_sha256={expected_hash} rebuilt_sha256={rebuilt_hash}; '
            'run scripts/runtime_artifacts.py build <plugin-root>'
        )
    print(f'OK: verified {label} sha256={expected_hash}')


def verify(plugin_root: Path) -> None:
    validate_inputs(plugin_root)
    ptx_target = plugin_root / PTX_ARTIFACT
    native_target = plugin_root / NATIVE_ARTIFACT
    clock_target = plugin_root / CLOCK_ARTIFACT
    aac_target = plugin_root / AAC_MT_ARTIFACT
    require_file(ptx_target)
    require_file(native_target)
    require_file(clock_target)
    require_file(aac_target)
    ptx_temp = temp_path_for(ptx_target)
    native_temp = temp_path_for(native_target)
    clock_temp = temp_path_for(clock_target)
    aac_temp = temp_path_for(aac_target)
    try:
        build_ptx(plugin_root, ptx_temp)
        build_native(plugin_root, native_temp)
        build_audio_clock(plugin_root, clock_temp, native_compiler())
        build_aac_encode_mt(plugin_root, aac_temp, native_compiler())
        ptx_temp.chmod(0o644)
        native_temp.chmod(0o755)
        assert_matches(ptx_target, ptx_temp, 'PTX')
        assert_matches(native_target, native_temp, 'native runtime')
        assert_matches(clock_target, clock_temp, 'audio clock carrier')
        assert_matches(aac_target, aac_temp, 'multi-channel AAC encoder')
        validate_artifact_abi(plugin_root, ptx_target, native_target, 'packaged')
        validate_artifact_abi(plugin_root, ptx_temp, native_temp, 'rebuilt')
    finally:
        ptx_temp.unlink(missing_ok=True)
        native_temp.unlink(missing_ok=True)
        clock_temp.unlink(missing_ok=True)
        aac_temp.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description='Build or verify deterministic gpuNormalizeAudio runtime artifacts.')
    parser.add_argument('command', choices=('build', 'verify', 'clean-stale'))
    parser.add_argument('plugin_root', type=Path)
    args = parser.parse_args()
    plugin_root = args.plugin_root.resolve()
    if not plugin_root.is_dir():
        fail(f'plugin root is not a directory: {plugin_root}')
    with artifact_lock():
        if args.command == 'build':
            build(plugin_root)
        elif args.command == 'verify':
            verify(plugin_root)
        else:
            clean_stale(plugin_root)


if __name__ == '__main__':
    main()
