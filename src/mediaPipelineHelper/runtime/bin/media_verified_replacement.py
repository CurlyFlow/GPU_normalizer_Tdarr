"""Exact-job acceptance consumer and retained-original storage transaction."""

import hashlib
import json
from pathlib import Path

from media_flow_authority import FlowAuthority
from media_history_store import private_json, retain_private
from media_integrity_admission import admit_finish, file_binding, read_binding, require_producer
from media_original_retention import replace_retaining_original
from media_retention_copy import copy_candidate, private_child
from media_retention_publication import verify_retention_history, verify_publication_generation
from tdarr_media_names import path_identity
from media_restart import restart_from_original, discard_unadmitted_state
from media_finished_checkpoint import require_finished_audit


def replacement_paths(authority, create=True):
    owner = authority.publication_owner
    if owner is not None:
        package = owner['directory']
    else:
        parent = authority.job_file.parent
        if parent.resolve(strict=True) != parent:
            raise ValueError('Retention package is not canonical')
        info = parent.stat()
        package = [info.st_dev, info.st_ino]
    identity = hashlib.sha256(json.dumps([authority.library_id, str(authority.job_file), package]).encode()).hexdigest()
    root = authority.state_root / (identity + '.retention')
    if create:
        root = private_child(authority.state_root, root.name)
    incoming, original, transaction = [private_child(root, name) if create else root / name
                                       for name in ('incoming', 'original', 'transaction')]
    return {'acceptance': root / 'acceptance.json', 'copy': incoming / 'candidate.mp4',
            'copyRecord': transaction / 'copy.json', 'original': original / authority.job_file.name,
            'journal': transaction / 'replacement.json',
            'destination': authority.job_file.with_suffix('.mp4')}


def replace_verified(authority, scope, binding, checkpoint=lambda _: None):
    authority.assert_owner()
    if (scope['original'] != str(authority.job_file) or scope['library'] != authority.library_id
            or scope['stateRoot'] != str(authority.state_root)
            or Path(scope['candidate']).suffix.lower() != '.mp4'):
        raise ValueError('Verified replacement does not identify the exact job')
    paths = replacement_paths(authority, create=False)
    if paths['acceptance'].exists():
        admitted = private_json(paths['acceptance'])
        if (admitted.get('schema') != 'media-admitted-finish.v1'
                or admitted.get('scope') != scope or admitted.get('binding') != binding):
            raise ValueError('Replacement differs from its immutable acceptance')
        require_producer(admitted['evidence'])
    else:
        admitted = admit_finish(binding, scope)
        authority.assert_owner()
        paths = replacement_paths(authority)
        retain_private(paths['acceptance'], admitted)
        checkpoint('acceptance')
    if paths['copyRecord'].exists():
        record = private_json(paths['copyRecord'])
        if (record.get('source') != scope['candidate'] or record.get('target') != str(paths['copy'])
                or record.get('expected') != admitted['expected']['candidate']):
            raise ValueError('Candidate transport plan differs from acceptance')
        candidate = record['identity']
    else:
        candidate = copy_candidate(scope['candidate'], paths['copy'], paths['copyRecord'],
                                   admitted['expected']['candidate'], authority.assert_owner, checkpoint)
    receipt = replace_retaining_original(
        authority.job_file, paths['copy'], paths['destination'], paths['original'], paths['journal'],
        {'original': admitted['expected']['original'], 'candidate': candidate}, authority.assert_owner, checkpoint)
    return {'output': receipt['destination'], 'replacement': file_binding(str(paths['journal']) + '.installed')}


def require_retained_installation(authority, scope, binding, file):
    authority.assert_owner()
    paths = replacement_paths(authority, create=False)
    if (not isinstance(binding, dict)
            or binding.get('file') != str(paths['journal']) + '.installed'
            or str(file) != str(paths['destination'])):
        raise ValueError('Verified retained replacement is required before publication')
    receipt = read_binding(binding)
    admitted = private_json(paths['acceptance'])
    if (admitted.get('schema') != 'media-admitted-finish.v1'
            or any(admitted.get('scope', {}).get(key) != value for key, value in scope.items())):
        raise ValueError('Publication differs from admitted replacement scope')
    require_producer(admitted['evidence'])
    verify_retention_history(authority, paths, admitted, receipt)
    plan = authority.load_plan() if authority.publication_owner is not None else None
    if plan is not None:
        verify_publication_generation(authority, scope, paths, receipt, plan)
        return receipt
    if (receipt['destinationIdentity'] != list(path_identity(paths['destination']))
            or paths['copy'].exists()
            or (authority.job_file != paths['destination'] and authority.job_file.exists())):
        raise ValueError('Retained replacement generation changed')
    return receipt


def inspect_retained_checkpoint(authority, scope, file):
    """Read only; never complete an interrupted copy or replacement."""
    authority.assert_owner()
    paths = replacement_paths(authority, create=False)
    installed = Path(str(paths['journal']) + '.installed')
    if not installed.exists():
        return False
    require_retained_installation(authority, scope, file_binding(installed), file)
    return True


def admit_restart(authority, scope, file):
    """Discard unfinished job work; only publication already begun may continue."""
    authority.assert_owner()
    authority.bind_publication(scope['completedRoot'])
    paths = replacement_paths(authority, create=False)
    if not paths['acceptance'].parent.exists():
        return None
    if not paths['acceptance'].exists():
        discard_unadmitted_state(authority, paths['acceptance'].parent)
        return None
    admitted = private_json(paths['acceptance'])
    if (any(admitted.get('scope', {}).get(key) != value for key, value in scope.items())
            or str(file) not in {str(authority.job_file), str(paths['destination'])}):
        raise ValueError('Finished continuation differs from the admitted job')
    if authority.publication_owner is not None and authority.load_plan() is not None:
        result = {'output': str(paths['destination']),
                  'replacement': file_binding(str(paths['journal']) + '.installed')}
    else:
        restart_from_original(authority, paths, admitted)
        return None
    installed = require_retained_installation(authority, scope, result['replacement'], result['output'])
    result['processingAudit'] = require_finished_audit(authority, result['output'], installed)
    return result


def replacement_request(request, read_staged, *, min_file_size_bytes=0):
    if (not isinstance(request, dict) or set(request) != {
            'fileObjects', 'stagingRoot', 'completedRoot', 'stateRoot', 'ffmpeg', 'ffprobe', 'integrity', 'retainOriginal'}
            or request['retainOriginal'] is not True):
        raise ValueError('Exact retained replacement request is required')
    objects = request['fileObjects']
    if not isinstance(objects, dict) or set(objects) != {'inputFileObj', 'originalLibraryFile'}:
        raise ValueError('Exact file-flow identities are required')
    original, current = objects['originalLibraryFile'], objects['inputFileObj']
    scope = {'original': original['_id'], 'candidate': current['_id'], 'library': original['DB'],
             **{key: request[key] for key in ('stagingRoot', 'completedRoot', 'stateRoot', 'ffmpeg', 'ffprobe')}}
    authority = FlowAuthority(scope['original'], scope['library'], scope['stateRoot'], read_staged,
                              min_file_size_bytes=min_file_size_bytes, allow_sibling_jobs=True)
    with authority.acquire(Path(scope['original']).parent, scope['stagingRoot'], scope['completedRoot']):
        return replace_verified(authority, scope, request['integrity'])
