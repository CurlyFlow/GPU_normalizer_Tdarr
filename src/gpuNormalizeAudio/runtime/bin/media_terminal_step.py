"""Plugin-owned terminal boundary: inspect, rename the package and return one path."""

from pathlib import Path
import json
import signal
import sys
import traceback

from media_flow_authority import FlowAuthority, FlowOwnershipError
from media_publication import publish_finished_media
from media_finished_checkpoint import retain_finished, finished_checkpoint, validate_processing_audit
from media_verified_replacement import require_retained_installation, admit_restart


def finalize_move(request, read_staged, read_file=None):
    required = {'fileObjects', 'stagingRoot', 'completedRoot', 'stateRoot', 'ffmpeg', 'ffprobe'}
    resume = request.get('resumeOnly') is True if isinstance(request, dict) else False
    if resume:
        required.add('resumeOnly')
    else:
        required.update(('replacement', 'processingAudit'))
    if not isinstance(request, dict) or set(request) != required:
        raise ValueError('Exact final Move request is required')
    for key in required - {'fileObjects', 'resumeOnly', 'replacement', 'processingAudit'}:
        if not isinstance(request[key], str) or not request[key] or '\0' in request[key]:
            raise ValueError('Invalid final Move configuration')
    objects = request['fileObjects']
    if not isinstance(objects, dict) or set(objects) != {'inputFileObj', 'originalLibraryFile'}:
        raise ValueError('Both existing file-flow identities are required')
    original = objects['originalLibraryFile']
    current = objects['inputFileObj']
    if not isinstance(original, dict) or not isinstance(current, dict):
        raise ValueError('Invalid file-flow identities')
    job_file, library = original.get('_id'), original.get('DB')
    file = current.get('_id')
    if any(not isinstance(value, str) or not value or '\0' in value
           for value in (job_file, library, file)):
        raise ValueError('Original job, library and finished file are required')
    state = Path(request['stateRoot'])
    # The operator provisions this private directory; a worker cannot create an
    # arbitrary state namespace by supplying a new path in a Flow input.
    if not state.is_absolute() or state.resolve(strict=True) != state:
        raise ValueError('Pre-provisioned canonical state directory is required')
    authority = FlowAuthority(job_file, library, state, read_staged)
    scope = {'original': job_file, 'library': library,
             **{key: request[key] for key in ('stagingRoot', 'completedRoot', 'stateRoot', 'ffmpeg', 'ffprobe')}}
    with authority.acquire(Path(job_file).parent, request['stagingRoot'], request['completedRoot']):
        if resume:
            result = admit_restart(authority, scope, file)
            if result:
                return {'resumeFinished': True, **result}
            if finished_checkpoint(authority, file):
                raise ValueError('Legacy finished bytes lack admitted-original integrity proof')
            return {'resumeFinished': False}
        authority.bind_publication(request['completedRoot'])
        installed = require_retained_installation(authority, scope, request['replacement'], file)
        audit = validate_processing_audit(authority, request['processingAudit'], installed['retainedIdentity'])
        if Path(file).exists():
            retain_finished(authority, file, audit, installed['retainedIdentity'])
    return publish_finished_media(file, request['stagingRoot'], request['completedRoot'],
                                  authority.journal_path, objects, authority,
                                   ffprobe=request['ffprobe'], ffmpeg=request['ffmpeg'], read_file=read_file,
                                   publication_owner=authority.publication_owner)


def main():

    def interrupted(*_):
        raise TimeoutError('Final media step interrupted')

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.alarm(14400)
    try:
        if sys.argv[1:] == ['--owned-process-group']:
            from media_scan_process import adopt_process_group
            adopt_process_group()
        elif len(sys.argv) != 1:
            raise ValueError('Invalid terminal worker invocation')
        data = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            raise ValueError('Final Move request is oversized')
        request = json.loads(data)
        from tdarr_api import configured_reader
        config = request.pop('tdarr')
        read_tdarr = configured_reader(config)

        def read_staged():
            return read_tdarr('StagedJSONDB', 'getAll', '')

        def read_file(file):
            return read_tdarr('FileJSONDB', 'getById', file)

        if 'decisionAudit' in request:
            from media_processing_audit import processing_audit
            result = processing_audit(request, read_staged)
        elif 'completedRejection' in request:
            from media_completed_rejection import try_completed_rejection
            from arr_import_recovery import arr_get
            from tdarr_api import configured_file_remover
            connection = request.pop('completedRejection')
            if (set(connection) != {'application', 'host', 'apiKey'}
                    or connection['application'] != request.get('application')):
                raise ValueError('Exact Arr decision connection is required')
            inputs = {'arr': connection['application'], 'arr_host': connection['host'], 'arr_api_key': connection['apiKey']}
            result = try_completed_rejection(request, read_staged, lambda endpoint: arr_get(inputs, endpoint),
                                             read_file, configured_file_remover(config))
        elif 'inputRecovery' in request:
            from media_input_recovery_audit import record_input_recovery
            result = record_input_recovery(request, read_staged)
        elif 'rejection' in request:
            from media_rejection_step import reject_download
            prepare = request.pop('prepareRejection', False)
            if type(prepare) is not bool:
                raise ValueError('Invalid rejection preparation phase')
            result = reject_download(request, read_staged, prepare_only=prepare)
        elif 'retainOriginal' in request:
            from media_verified_replacement import replacement_request
            result = replacement_request(request, read_staged)
        else:
            result = finalize_move(request, read_staged, read_file)
        print(json.dumps(result))
    except Exception as error:
        location = traceback.extract_tb(error.__traceback__)[-1]
        # Code identity is safe operational evidence; messages/locals can contain
        # private media names, API origins or credentials and are never emitted.
        print(json.dumps({'error': type(error).__name__, 'published': False,
                          **({'failureCode': error.code} if isinstance(error, FlowOwnershipError) else {}),
                          'failureLocation': f'{Path(location.filename).name}:{location.lineno}'}))
        raise SystemExit(1) from None
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    main()
