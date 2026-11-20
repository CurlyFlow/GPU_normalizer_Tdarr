"""Consume the private JS media acceptance; do not duplicate signal algorithms."""

from pathlib import Path
import shutil

from media_history_store import private_json
from tdarr_media_names import path_identity


def file_binding(file):
    file = Path(file)
    if not file.is_absolute() or file.resolve(strict=True) != file:
        raise ValueError('Canonical acceptance file is required')
    identity = list(path_identity(file))
    if identity[7] is None or identity[4] < 1:
        raise ValueError('Complete regular-file acceptance identity is required')
    return {'file': str(file), 'identity': {
        'stamp': ':'.join(str(identity[index]) for index in (0, 1, 4, 5, 6)),
        'bytes': identity[4], 'sha256': identity[7]}}


def read_binding(binding):
    if not isinstance(binding, dict) or set(binding) != {'file', 'identity'}:
        raise ValueError('Exact private acceptance binding is required')
    if file_binding(binding['file']) != binding:
        raise ValueError('Acceptance file generation changed')
    value = private_json(binding['file'])
    if file_binding(binding['file']) != binding:
        raise ValueError('Acceptance file changed while being read')
    return value


def require_producer(value):
    owner = Path(__file__).resolve().parents[2] / 'lib'
    producer = value.get('producer', {})
    modules = producer.get('modules', [])
    if (producer.get('roots') != [str(owner / 'pipelineFinishWorker.js')]
            or not isinstance(modules, list) or not 1 <= len(modules) <= 4096):
        raise ValueError('Foreign or missing complete-finish producer')
    found = set()
    for entry in modules:
        if not isinstance(entry, list) or len(entry) != 2 or entry[0] in found:
            raise ValueError('Incomplete finish producer inventory')
        file, identity = entry
        if Path(file).parent != owner or file_binding(file)['identity'] != identity:
            raise ValueError('Finish producer generation changed')
        found.add(file)
    required = ('pipelineFinishWorker.js', 'pipelineFinishChain.js', 'pipelineFinishCarriers.js',
                'pipelineFinishInputs.js', 'pipelineFinishProtocol.js')
    if any(str(owner / name) not in found for name in required):
        raise ValueError('Incomplete finish producer closure')


def admit_finish(binding, scope):
    value = read_binding(binding)
    request = value.get('request', {})
    roles = {'originalFile': scope['original'], 'candidateFile': scope['candidate'],
             'stagingRoot': scope['stagingRoot'], 'completedRoot': scope['completedRoot'],
             'stateRoot': scope['stateRoot'], 'libraryId': scope['library'],
             'ffmpegPath': scope['ffmpeg'], 'ffprobePath': scope['ffprobe']}
    coverage = value.get('coverage', {})
    videos = coverage.get('videos', [])
    if (value.get('schema') != 'media-finish-integrity.v1'
            or value.get('scope') != 'admitted-original-intended-transformations'
            or value.get('status') != 'pass' or value.get('errors') != []
            or any(request.get(key) != field for key, field in roles.items())
            or coverage.get('status') != 'pass'
            or any(coverage.get(key, {}).get('metadata', {}).get('status') != 'pass'
                   for key in ('preparation', 'audio'))
            or not isinstance(videos, list) or not 1 <= len(videos) <= 2
            or len(videos) != len(request.get('videos', []))
            or any(video.get('status') != 'pass' for video in videos)):
        raise ValueError('Complete admitted-original finish acceptance is required')
    require_producer(value)
    inputs = value.get('inputs', [])
    if not isinstance(inputs, list) or not 1 <= len(inputs) <= 4096:
        raise ValueError('Complete admitted input generations are required')
    found = set()
    for entry in inputs:
        if (not isinstance(entry, dict) or set(entry) != {'file', 'identity'}
                or entry['file'] in found or file_binding(entry['file']) != entry):
            raise ValueError('Admitted input generation changed')
        found.add(entry['file'])
    if any(request.get(key) not in found for key in ('originalFile', 'preparedFile', 'audioFile', 'candidateFile')):
        raise ValueError('Incomplete admitted media role coverage')
    preparation = read_binding(request['preparation'])
    source_input = preparation.get('sourceInput')
    if (not isinstance(source_input, dict) or source_input.get('file') != preparation.get('mapping', {}).get('sourceId')
            or source_input not in inputs):
        raise ValueError('Incomplete admitted preparation source generation')
    subtitles = preparation.get('actual', {}).get('subtitles')
    if (not isinstance(subtitles, list) or len(subtitles) > 256
            or coverage['preparation'].get('extractions') != [dict(record, status='pass') for record in subtitles]
            or any({'file': record['file'], 'identity': record['identity']} not in inputs for record in subtitles)):
        raise ValueError('Incomplete admitted subtitle extraction coverage')
    for name in ('decoder', 'prober'):
        tool = value.get(name, {})
        expected = scope['ffmpeg' if name == 'decoder' else 'ffprobe']
        executable = shutil.which(expected)
        if not executable or str(Path(executable).resolve(strict=True)) != tool.get('executable'):
            raise ValueError('Admitted media tool changed')
        for item in (tool, *([tool['native']] if tool.get('native') else [])):
            actual = file_binding(item['executable'])['identity']
            if any(actual[key] != item.get(key) for key in ('sha256', 'bytes')):
                raise ValueError('Admitted media tool bytes changed')
    return {'schema': 'media-admitted-finish.v1', 'scope': scope, 'binding': binding,
            'evidence': value, 'expected': {
                key: list(path_identity(Path(scope[key]))) for key in ('original', 'candidate')}}
