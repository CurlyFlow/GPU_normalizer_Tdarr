"""Correct an owned, committed DV label through the existing package protocol.

No media re-encoding, downloader-row mutation, policy override or receipt rewrite.
The caller supplies exact scope and live operational authority. An immutable
correction link switches projection only after the new byte-proved result is
durable. Every original plan/result/registration stays unchanged and in place.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sys

from media_history_store import private_json, retain_private, verify_committed, publication_record_digest
from media_package_transaction import publish_package, package_namespace
from media_publication import retarget_file_objects
from tdarr_media_names import package_identity, process


def superseded_plans(path, base, registration):
    paths = sorted(path.parent.glob('*.plan'))
    if len(paths) > 1000:
        raise ValueError('Correction inventory exceeds its bound')
    previous = []
    for other in paths:
        plan = private_json(other)
        if Path(plan['source']).parent != Path(base['source']).parent:
            continue
        registered = other.with_suffix('.history-registration')
        provenance = private_json(registered) if registered.exists() else None
        if provenance is not None and provenance.get('nzo_id') != registration['nzo_id']:
            continue
        if (provenance not in (None, registration)
                or any(plan.get(key) != base.get(key) for key in ('source', 'target'))
                or plan.get('evidence', {}).get('finishedIdentity') != base['evidence']['finishedIdentity']
                or (other != path and (other.with_suffix('.result').exists()
                                      or other.with_suffix('.history-verified').exists()))):
            raise ValueError('Another publication outcome prevents correction')
        previous.append({'path': str(other), 'digest': publication_record_digest(plan)})
    if not any(item['path'] == str(path) for item in previous):
        raise ValueError('Committed original is absent from the correction inventory')
    return previous


def correctable_fallback(previous, actual):
    return (previous.get('dynamicRange') == 'DV' and actual.get('dynamicRange') in {'DV.HDR10', 'DV.HDR10Plus'}
            and {key: value for key, value in actual.items() if key != 'dynamicRange'}
            == {key: value for key, value in previous.items() if key != 'dynamicRange'})


def correction_plan(path, base, registration, scope, journal, ffprobe, ffmpeg):
    file = Path(base['target'])
    if not verify_committed(path, base) or not file.exists():
        raise ValueError('Correction requires the still-present verified media')
    if Path(base['source']).parent.exists():
        raise ValueError('Original staging package still exists')
    preview = process(file, scope['completedRoot'], ffprobe=ffprobe, ffmpeg=ffmpeg)
    actual, previous = preview['facts'], base['evidence']['facts']
    if (not correctable_fallback(previous, actual)
            or preview['finishedIdentity'][-1] != base['evidence']['finishedIdentity'][-1]):
        raise ValueError('Only positively proved, otherwise unchanged DV fallback naming may be corrected')
    target = Path(preview['target'])
    source = Path(base['source']).parent / file.name
    names = {Path(name).name: Path(name).name for name in preview['packageIdentity'] if Path(name) != file.parent}
    names.update({Path(old).name: Path(new).name for old, new in preview['renames']})
    current = preview['packageIdentity']
    preview = {**preview, 'source': str(source), 'packageIdentity': {
        str(source.parent if Path(name) == file.parent else source.parent / Path(name).name): value
        for name, value in current.items()}}
    return {'source': str(source), 'destination': str(target.parent), 'target': str(target),
            'journal': str(journal), 'names': names, 'evidence': preview,
            'correctionSource': str(file), 'correctionPackageIdentity': current,
            'correctionOf': superseded_plans(path, base, registration)}


def correct_publication(path, scope, assert_owner, ffprobe='ffprobe', ffmpeg='ffmpeg', checkpoint=lambda _: None):
    path = Path(path)
    root = Path(scope['stateRoot'])
    if (path.parent != root or not re.fullmatch(r'[a-f0-9]{64}\.plan', path.name) or root.resolve(strict=True) != root
            or root.stat().st_uid != os.geteuid() or root.stat().st_mode & 0o077):
        raise ValueError('Correction must use its exact private publication scope')
    base = private_json(path)
    if (Path(base['source']).parent.parent != Path(scope['stagingRoot'])
            or Path(base['target']).parent.parent != Path(scope['completedRoot'])):
        raise ValueError('Original publication escapes the correction scope')
    registration = private_json(path.with_suffix('.history-registration'))
    original = private_json(path.with_suffix('.result'))
    if not path.with_suffix('.history-verified').exists():
        raise ValueError('Original publication has no independent proof')
    identity = hashlib.sha256(('naming-correction:' + str(path)).encode()).hexdigest()
    revised_path = root / (identity + '.plan')
    revised = private_json(revised_path) if revised_path.exists() else correction_plan(
        path, base, registration, scope, revised_path.with_suffix('.journal'), ffprobe, ffmpeg)
    if (revised.get('correctionSource') != base['target']
            or not any(item == {'path': str(path), 'digest': publication_record_digest(base)} for item in revised['correctionOf'])):
        raise ValueError('Retained correction belongs to another publication')

    def owned():
        if assert_owner() is not True or Path(base['source']).parent.exists():
            raise PermissionError('Live authority for the completed package was lost')
        for item in revised['correctionOf']:
            if publication_record_digest(private_json(Path(item['path']))) != item['digest']:
                raise ValueError('Original publication evidence changed')
        return True

    with package_namespace(scope['stagingRoot'], scope['completedRoot']):
        owned()
        if not Path(revised['journal']).exists():
            expected = {name: tuple(value) for name, value in revised['correctionPackageIdentity'].items()}
            if package_identity(Path(base['target']).parent) != expected:
                raise ValueError('Finished package changed before correction admission')
        retain_private(revised_path, revised)
        publish_package(Path(base['target']).parent, revised['destination'], revised['journal'], revised['names'],
                        owned, checkpoint)
        result = {**original, 'fileObjects': retarget_file_objects(original['fileObjects'], revised['target']),
                  'moveDestination': revised['target'], 'notifyPath': revised['target'],
                  'publishedStorage': revised['destination'], 'publishedName': Path(revised['destination']).name}
        retain_private(revised_path.with_suffix('.result'), result)
        if not verify_committed(revised_path, revised):
            raise ValueError('Corrected publication lacks full byte proof')
        retain_private(revised_path.with_suffix('.history-registration'), registration)
        retain_private(revised_path.with_suffix('.publication-correction'), {
            'previous': revised['correctionOf'], 'result': publication_record_digest(result)})
        owned()
        return {**result, 'publicationCorrected': True, 'receipt': str(revised_path.with_suffix('.result'))}


def correct_request(request, read_staged, read_arr):
    required = {'application', 'host', 'apiKey', 'plan', 'stagingRoot', 'completedRoot', 'stateRoot'}
    if not isinstance(request, dict) or set(request) != required or request['application'] not in {'radarr', 'sonarr'}:
        raise ValueError('Require an exact configured publication correction request')
    scope = {key: request[key] for key in ('stagingRoot', 'completedRoot', 'stateRoot')}
    path = Path(request['plan'])
    base = private_json(path)
    registration = private_json(path.with_suffix('.history-registration'))
    correction_id = hashlib.sha256(('naming-correction:' + str(path)).encode()).hexdigest()
    if not (path.parent / (correction_id + '.plan')).exists():
        queue = read_arr('queue?page=1&pageSize=1000')
        rows = queue.get('records', [])
        selected = [row for row in rows if row.get('downloadId') == registration['nzo_id']]
        if queue.get('totalRecords') != len(rows) or not selected:
            raise ValueError('Current tracked publication ownership is unavailable')
        for row in selected:
            reasons = [reason for issue in row.get('statusMessages', []) for reason in issue.get('messages', [])]
            if (row.get('status') != 'completed' or Path(row.get('outputPath') or '') != Path(base['destination'])
                    or row.get('trackedDownloadState') not in {'importPending', 'importBlocked'}
                    or not reasons or any(not reason.startswith('Not a Custom Format upgrade for existing ') for reason in reasons)):
                raise ValueError('Correction is restricted to the observed naming-induced custom-format hold')

    def authority():
        stages = read_staged()
        if not isinstance(stages, list) or len(stages) > 128:
            raise PermissionError('Native job ownership is unknown')
        packages = {Path(base['source']).parent, Path(base['target']).parent}
        if any(Path(stage.get('originalLibraryFile', {}).get('_id') or '').parent in packages
               or Path(stage.get('inputFileObj', {}).get('_id') or '').parent in packages for stage in stages):
            raise PermissionError('A native job still owns this package')
        return True
    result = correct_publication(path, scope, authority)
    return {key: result[key] for key in ('publicationCorrected', 'publishedName', 'notifyPath', 'receipt')}


def main():
    try:
        if len(sys.argv) != 1:
            raise ValueError('Correction accepts private stdin only')
        payload = sys.stdin.buffer.read(32769)
        if len(payload) > 32768:
            raise ValueError('Correction request exceeds its bound')
        request = json.loads(payload)
        from arr_import_recovery import arr_get
        from tdarr_api import configured_reader
        read = configured_reader(request.pop('tdarr'))
        inputs = {'arr': request['application'], 'arr_host': request['host'], 'arr_api_key': request['apiKey']}
        print(json.dumps(correct_request(request, lambda: read('StagedJSONDB', 'getAll', ''),
                                        lambda endpoint: arr_get(inputs, endpoint))))
    except Exception as error:
        print(json.dumps({'error': type(error).__name__, 'publicationCorrected': False}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
