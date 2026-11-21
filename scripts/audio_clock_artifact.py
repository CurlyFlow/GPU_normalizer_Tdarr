"""Build the packet-copy carrier from original-workspace FFmpeg source, not old archives."""
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
BUILDS = ROOT / 'work/runtime-audio-clock'
ARTIFACT = Path('runtime/bin/audio_clock_mux')
ARCHIVES = ('libavformat/libavformat.a', 'libavcodec/libavcodec.a', 'libavutil/libavutil.a')
SDK_OUTPUTS = (*ARCHIVES, 'config.h', 'config_components.h', 'libavutil/avconfig.h', 'libavutil/ffversion.h')
BUILD_ENV = {'PATH': os.defpath, 'LC_ALL': 'C', 'LANG': 'C', 'TZ': 'UTC',
             'SOURCE_DATE_EPOCH': '0', 'TMPDIR': '/tmp'}
CONFIGURE = (
    '--prefix=/usr', '--disable-everything', '--disable-programs', '--disable-doc', '--disable-debug',
    '--disable-autodetect', '--disable-network', '--disable-x86asm', '--disable-avfilter',
    '--disable-avdevice', '--disable-swscale', '--disable-swresample', '--enable-pic',
    '--enable-demuxer=mov', '--enable-muxer=mp4,mov', '--enable-protocol=file',
)


def identity(file: Path) -> dict:
    before = file.stat()
    if file.is_symlink() or not file.is_file():
        raise ValueError(f'Non-regular clock build input: {file}')
    digest = hashlib.sha256(file.read_bytes()).hexdigest()
    stamp = lambda info: [str(value) for value in (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)]
    if stamp(file.stat()) != stamp(before):
        raise ValueError('Clock build input changed while hashing')
    return {'file': str(file), 'stamp': stamp(before), 'sha256': digest}


def source_names() -> list[str]:
    def listed(*options):
        return subprocess.check_output(['git', '-C', str(SOURCE), 'ls-files', *options, '-z'], timeout=30).decode().split('\0')
    names = listed('--cached')
    # Preserve all tracked inputs and local source additions, not pre-existing
    # diagnostic executables/archives. They are neither linked nor rebuilt here.
    additions = listed('--others', '--exclude-standard')
    source_suffixes = {'.c', '.h', '.asm', '.S', '.inc', '.mak', '.mk', '.sh', '.py', '.cpp', '.cc', '.hpp', '.m', '.mm'}
    names.extend(name for name in additions if Path(name).suffix in source_suffixes
                 or Path(name).name in {'Makefile', 'configure', 'VERSION', 'RELEASE'})
    if len(names) < 1000 or len(names) > 20000:
        raise ValueError('Unexpected FFmpeg source inventory')
    return [name for name in sorted(set(names)) if name]


def source_inputs() -> list[dict]:
    return [identity(SOURCE / name) for name in source_names()]


def compiler_inputs(compiler: list[str]) -> list[dict]:
    files = {Path(shutil.which(compiler[0])).resolve(strict=True)}
    for name in ('cc1', 'collect2', 'as', 'ld', 'ar', 'ranlib'):
        value = subprocess.check_output([*compiler, '-print-prog-name=' + name], text=True, timeout=10, env=BUILD_ENV).strip()
        files.add(Path(value if '/' in value else shutil.which(value, path=BUILD_ENV['PATH'])).resolve(strict=True))
    return [identity(file) for file in sorted(files)]


def run_build(command: list[str], directory: Path, log: Path) -> None:
    with log.open('ab') as output:
        result = subprocess.run(command, cwd=directory, stdout=output, stderr=subprocess.STDOUT, timeout=1800, env=BUILD_ENV)
    if result.returncode:
        with log.open('rb') as output:
            output.seek(max(0, log.stat().st_size - 6000))
            detail = output.read().decode(errors='replace')
        raise RuntimeError(f'Clock source build failed ({result.returncode}): {detail}')


def sdk(compiler: list[str]) -> tuple[Path, Path]:
    inputs = source_inputs()
    version = subprocess.check_output([*compiler, '--version'], text=True, timeout=10)
    spec = {'schema': 'audio-clock-source-sdk.v1', 'source': inputs, 'configure': CONFIGURE,
            'compiler': compiler, 'compilerVersion': version, 'tools': compiler_inputs(compiler),
            'environment': BUILD_ENV, 'owner': identity(Path(__file__).resolve())}
    digest = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()
    BUILDS.mkdir(parents=True, exist_ok=True)
    record = BUILDS / f'{digest}.json'
    if record.exists():
        saved = json.loads(record.read_text())
        directory = Path(saved['directory'])
        if (saved['spec'] != json.loads(json.dumps(spec)) or directory.parent != BUILDS
                or directory.is_symlink() or not directory.is_dir()
                or [identity(directory / name) for name in SDK_OUTPUTS] != saved['outputs']):
            raise ValueError('Previously source-built clock SDK changed')
        return directory, record
    directory = Path(tempfile.mkdtemp(prefix='sdk-', dir=BUILDS))
    # FFmpeg explicitly supports a src/ build reference. It points at the original
    # workspace; no checkout, source copy, in-tree rebuild or old archive is used.
    (directory / 'src').symlink_to(SOURCE, target_is_directory=True)
    log = directory / 'build.log'
    run_build(['src/configure', *CONFIGURE, '--cc=' + shlex.join(compiler)], directory, log)
    jobs = min(8, len(os.sched_getaffinity(0)))
    run_build(['make', '-j', str(jobs), *ARCHIVES], directory, log)
    if (inputs != source_inputs() or spec['tools'] != compiler_inputs(compiler)
            or spec['owner'] != identity(Path(__file__).resolve())):
        raise ValueError('Original FFmpeg source changed during SDK compilation')
    saved = {'spec': spec, 'directory': str(directory),
             'outputs': [identity(directory / name) for name in SDK_OUTPUTS]}
    with record.open('x') as output:
        os.chmod(record, 0o600)
        json.dump(saved, output, sort_keys=True)
        output.flush()
        os.fsync(output.fileno())
    return directory, record


def build_audio_clock(plugin_root: Path, output: Path, compiler: list[str]) -> dict:
    compiler = [str(Path(shutil.which(compiler[0])).resolve(strict=True)), *compiler[1:]]
    directory, record = sdk(compiler)
    native = plugin_root / 'runtime/bin'
    files = [native / name for name in ('audio_clock_mux.c', 'audio_clock_plan.c', 'audio_clock_edits.c', 'audio_clock_merge.c',
                                      'audio_clock_plan.h', 'audio_clock_io.h', 'audio_clock_edits.h', 'audio_clock_mux.h')]
    flags = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-D_FILE_OFFSET_BITS=64',
             '-I', str(directory), '-I', str(directory / 'src')]
    headers = set(files)
    for file in files[:4]:
        text = subprocess.check_output([*compiler, *flags, '-M', str(file)], text=True, timeout=30, env=BUILD_ENV)
        headers.update(Path(name).resolve(strict=True) for name in shlex.split(text.replace('\\\n', ' ').split(':', 1)[1]))
    inputs = sorted(headers | {directory / name for name in SDK_OUTPUTS})
    before, tools = [identity(file) for file in inputs], compiler_inputs(compiler)
    command = [*compiler, *flags, *map(str, files[:4]),
               '-Wl,--start-group', *[str(directory / name) for name in ARCHIVES], '-Wl,--end-group',
               '-lm', '-latomic', '-pthread', '-o', str(output)]
    subprocess.run(command, check=True, timeout=120, env=BUILD_ENV)
    if [identity(file) for file in inputs] != before or tools != compiler_inputs(compiler):
        raise ValueError('Clock carrier source changed while compiling')
    output.chmod(0o755)
    version = subprocess.check_output([str(output), '-version'], text=True, timeout=10).strip()
    if not version.startswith('audio-clock-mux.v1 '):
        raise ValueError('Invalid clock carrier ABI')
    print(f'OK: source-built {version}')
    return {'schema': 'audio-clock-carrier-build.v1', 'scope': 'packet-copy-proof-only', 'version': version,
            'sdk': identity(record), 'inputs': before + tools + [identity(Path(__file__).resolve()),
            identity(ROOT / 'scripts/runtime_artifacts.py')]}


def publish_build_manifest(proof: dict, artifact: Path) -> Path:
    directory = Path(tempfile.mkdtemp(prefix='carrier-', dir=BUILDS))
    manifest = directory / 'manifest.json'
    with manifest.open('x') as output:
        os.chmod(manifest, 0o600)
        json.dump({**proof, 'artifact': identity(artifact)}, output, sort_keys=True)
        output.flush()
        os.fsync(output.fileno())
    return manifest
