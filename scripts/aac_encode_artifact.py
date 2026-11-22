"""Build the bit-exact multi-channel AAC-LC encoder from local Jellyfin FFmpeg 7.1.2 source."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'work/ffmpeg-loudnorm-cuda-filter/jellyfin-ffmpeg-v7.1.2-2'
NASM_DIR = ROOT / 'work/ffmpeg-loudnorm-cuda-filter/tools/nasm-2.16.03'
PATCH = ROOT / 'scripts/aacenc_mt.patch'
BUILDS = ROOT / 'work/runtime-aac-encode'
ARTIFACT = Path('runtime/bin/aac_encode_mt')
ARCHIVES = (
    'libavformat/libavformat.a',
    'libavcodec/libavcodec.a',
    'libswresample/libswresample.a',
    'libavutil/libavutil.a',
)
SDK_OUTPUTS = (*ARCHIVES, 'config.h', 'config_components.h', 'libavutil/avconfig.h', 'libavutil/ffversion.h')
CONFIGURE = (
    '--prefix=/usr', '--disable-everything', '--disable-programs', '--disable-doc', '--disable-debug',
    '--disable-autodetect', '--disable-network', '--disable-avfilter', '--disable-avdevice',
    '--disable-swscale', '--enable-pic', '--enable-x86asm', '--enable-swresample',
    '--enable-encoder=aac', '--enable-muxer=mp4,ipod,adts', '--enable-protocol=file,pipe',
)


def _build_env() -> dict[str, str]:
    path_parts = [os.defpath]
    if NASM_DIR.is_dir():
        path_parts.insert(0, str(NASM_DIR))
    return {
        'PATH': ':'.join(path_parts),
        'LC_ALL': 'C',
        'LANG': 'C',
        'TZ': 'UTC',
        'SOURCE_DATE_EPOCH': '0',
        'TMPDIR': '/tmp',
    }


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _run_build(command: list[str], cwd: Path, log: Path, env: dict[str, str]) -> None:
    with log.open('ab') as out:
        result = subprocess.run(command, cwd=cwd, stdout=out, stderr=subprocess.STDOUT, timeout=1800, env=env)
    if result.returncode:
        with log.open('rb') as out:
            out.seek(max(0, log.stat().st_size - 6000))
            detail = out.read().decode(errors='replace')
        raise RuntimeError(f'AAC encoder SDK build failed ({result.returncode}): {detail}')


def _sdk(plugin_root: Path, compiler: list[str]) -> tuple[Path, Path]:
    env = _build_env()
    header = plugin_root / 'runtime/bin/aacenc_mt.h'
    head_rev = subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True, timeout=10).strip()
    version = subprocess.check_output([*compiler, '--version'], text=True, timeout=10)
    spec = {
        'schema': 'aac-encode-mt-sdk.v1',
        'head': head_rev,
        'patch_sha256': _sha256_file(PATCH),
        'header_sha256': _sha256_file(header),
        'owner_sha256': _sha256_file(Path(__file__).resolve()),
        'configure': list(CONFIGURE),
        'compiler': list(compiler),
        'compilerVersion': version,
    }
    digest = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()
    BUILDS.mkdir(parents=True, exist_ok=True)
    record = BUILDS / f'sdk-{digest}.json'
    if record.is_file():
        saved = json.loads(record.read_text())
        src_dir = Path(saved['src_dir'])
        build_dir = Path(saved['build_dir'])
        if (saved.get('spec') == spec and src_dir.is_dir() and build_dir.is_dir()
                and all((build_dir / rel).is_file() for rel in SDK_OUTPUTS)):
            return src_dir, build_dir

    root_dir = Path(tempfile.mkdtemp(prefix=f'aac-sdk-{digest[:12]}-', dir=BUILDS))
    src_dir = root_dir / 'src'
    build_dir = root_dir / 'build'
    src_dir.mkdir()
    build_dir.mkdir()
    log = root_dir / 'build.log'

    archive = subprocess.Popen(['git', '-C', str(SOURCE), 'archive', 'HEAD'], stdout=subprocess.PIPE)
    subprocess.run(['tar', '-x', '-C', str(src_dir)], stdin=archive.stdout, check=True, timeout=120)
    if archive.wait(timeout=30) != 0:
        raise RuntimeError('git archive of Jellyfin FFmpeg HEAD failed')

    shutil.copy2(header, src_dir / 'libavcodec/aacenc_mt.h')
    subprocess.run(['patch', '-p1', '-i', str(PATCH)], cwd=src_dir, check=True, stdout=subprocess.DEVNULL, timeout=30)
    (build_dir / 'src').symlink_to(src_dir, target_is_directory=True)
    _run_build(['src/configure', *CONFIGURE, '--cc=' + shlex.join(compiler)], build_dir, log, env)
    jobs = min(12, len(os.sched_getaffinity(0)))
    _run_build(['make', '-j', str(jobs), *ARCHIVES], build_dir, log, env)
    record.write_text(json.dumps({'spec': spec, 'src_dir': str(src_dir), 'build_dir': str(build_dir)}, sort_keys=True))
    return src_dir, build_dir


def build_aac_encode_mt(plugin_root: Path, output: Path, compiler: list[str]) -> None:
    compiler = [str(Path(shutil.which(compiler[0])).resolve(strict=True)), *compiler[1:]]
    env = _build_env()
    src_dir, build_dir = _sdk(plugin_root, compiler)
    driver = plugin_root / 'runtime/bin/aac_encode_mt.c'
    command = [
        *compiler, '-std=c11', '-O3', '-Wall', '-Wextra', '-Werror', '-D_FILE_OFFSET_BITS=64',
        f'-ffile-prefix-map={ROOT}=.', '-Wl,--build-id=none',
        '-I', str(build_dir), '-I', str(src_dir), str(driver),
        '-Wl,--start-group', *[str(build_dir / name) for name in ARCHIVES], '-Wl,--end-group',
        '-lm', '-latomic', '-pthread', '-o', str(output),
    ]
    subprocess.run(command, check=True, timeout=120, env=env)
    strip = shutil.which('strip', path=env['PATH'])
    if strip:
        subprocess.run([strip, '--strip-unneeded', str(output)], check=True, timeout=30, env=env)
    output.chmod(0o755)
    version = subprocess.check_output([str(output), '-version'], text=True, timeout=10).strip()
    if not version.startswith('aac-encode-mt.v1 '):
        raise ValueError(f'Invalid aac_encode_mt ABI: {version}')
    print(f'OK: source-built {version}')
