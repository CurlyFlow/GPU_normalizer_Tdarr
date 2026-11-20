"""Ordinary Arr import planning and durable, submit-once observation."""
import fcntl
import hashlib
import json
import os
import stat
import time
import urllib.request
from pathlib import Path, PurePosixPath
from urllib.parse import urlencode

IDENTITY_REJECTION = {
    'radarr': 'Found matching movie via grab history, but release was matched to movie by ID. Manual Import required.',
    'sonarr': 'Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible. See the FAQ for details.',
}
IMPORT_COMMAND = {'radarr': 'DownloadedMoviesScan', 'sonarr': 'DownloadedEpisodesScan'}


def import_receipt_path(inputs, file, download_id, root, *, legacy=False):
    host = str(inputs['arr_host']).strip().removesuffix('/')
    identity = json.dumps([inputs['arr'], host, file, download_id], separators=(',', ':'))
    suffix = '.package.jsonl' if download_id is None and not legacy else '.jsonl'
    return Path(root) / (hashlib.sha256(identity.encode()).hexdigest() + suffix)


def read_import_receipt(path):
    path = Path(path)
    if path.resolve(strict=True) != path:
        raise ValueError('Import receipt is not canonical')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor) as journal:
        info = os.fstat(journal.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != os.geteuid() or info.st_mode & 0o077):
            raise ValueError('Unsafe import receipt')
        fcntl.flock(journal.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
        raw = journal.read(65537)
    if len(raw) > 65536:
        raise ValueError('Import receipt exceeds its bound')
    return [json.loads(line) for line in raw.splitlines()]


def import_history_events(file, download_id, plan, prior_ids, history):
    events = [entry for entry in history
            if entry.get('id') not in prior_ids
            and (entry.get('downloadId') == download_id if download_id is not None else
                 entry.get('downloadId') is None or isinstance(entry.get('downloadId'), str))
            and entry.get(plan['entityKey']) in plan['entityIds']
            and entry.get('eventType') == 'downloadFolderImported'
            and entry.get('data', {}).get('droppedPath') == file
            and entry.get('data', {}).get('importedPath')]
    # Untracked means no downloader ID was supplied to the command. Arr may
    # resolve one itself from grab history. The fresh exact source/entity event
    # and current library file own this proof, not a null-ID join or a guessed ID.
    if download_id is None and len({entry[plan['entityKey']] for entry in events}) != len(events):
        return []
    return events


def completed_media_path(file):
    path = PurePosixPath(file)
    if (not path.is_absolute() or '..' in path.parts or '\x00' in file
            or str(path) != file or path.suffix.lower() not in {'.mkv', '.mp4', '.m4v'}):
        raise ValueError('An exact completed media path is required')
    return path


def ordinary_import_command(kind, file, download_id):
    path = completed_media_path(file)
    command = {'name': IMPORT_COMMAND[kind], 'path': str(path.parent) if download_id is None else file,
               'importMode': 'auto'}
    if download_id is not None:
        command['downloadClientId'] = download_id
    return command


def validate_import_records(records, kind, file, download_id):
    """Validate persisted submissions, including the concrete old file-scan format."""
    if len(records) not in {2, 3} or any(not isinstance(item, dict) for item in records):
        raise ValueError('Submission outcome is unknown; do not automatically resubmit')
    intent, submitted = records[:2]
    if any(intent.get(key) != value for key, value in {
            'application': kind, 'file': file, 'downloadId': download_id}.items()):
        raise ValueError('Receipt belongs to a different import')
    plan = intent.get('plan', {})
    expected = ordinary_import_command(kind, file, download_id)
    legacy = {**expected, 'path': file}
    if (plan.get('command') not in (expected, legacy) or type(submitted.get('commandId')) is not int
            or submitted['commandId'] <= 0 or plan.get('entityKey') != ('movieId' if kind == 'radarr' else 'episodeId')
            or not plan.get('entityIds') or any(type(value) is not int or value <= 0 for value in plan['entityIds'])
            or not isinstance(intent.get('priorHistoryIds'), list)
            or (download_id is None and (type(plan.get('sourceSize')) is not int or plan['sourceSize'] <= 0))):
        raise ValueError('Import receipt has no exact command and entity proof')
    terminal = records[2] if len(records) == 3 else None
    if terminal is not None and (type(terminal.get('imported')) is not bool
            or terminal.get('application') != kind or terminal.get('commandId') != submitted['commandId']
            or terminal.get('entityIds') != plan['entityIds']
            or terminal.get('commandStatus') not in {'completed', 'failed', 'aborted', 'cancelled'}
            or (not terminal['imported'] and terminal.get('status') != 'command-terminal-without-verified-import')):
        raise ValueError('Invalid terminal import receipt')
    return plan, submitted['commandId'], terminal


def validate_import_candidate(file, candidate, download_id):
    allowed = (None, '') if download_id is None else (download_id,)
    if (candidate.get('path') != file or candidate.get('downloadId') not in allowed
            or candidate.get('rejections') != [] or type(candidate.get('size')) is not int
            or candidate['size'] <= 0 or candidate.get('movieFileId') or candidate.get('episodeFileId')):
        raise ValueError('Import preview is rejected, incomplete or refers to an existing file')


def identity_import_plan(kind, file, queued, candidates, entities):
    """Validate one identity-only rejection; use normal decisions, not ManualImport."""
    if kind not in IDENTITY_REJECTION:
        raise ValueError('Unsupported Arr application')
    path = completed_media_path(file)
    if not queued or len(candidates) != 1:
        raise ValueError('Require one tracked download and one import candidate')
    downloads = {item.get('downloadId') for item in queued}
    if len(downloads) != 1 or not isinstance(next(iter(downloads)), str) or not next(iter(downloads)):
        raise ValueError('Ambiguous download identity')
    for item in queued:
        reasons = [reason for issue in item.get('statusMessages', []) for reason in issue.get('messages', [])]
        if item.get('status') != 'completed' or item.get('trackedDownloadState') != 'importBlocked':
            raise ValueError('Tracked download is no longer completed and identity-blocked')
        if reasons != [IDENTITY_REJECTION[kind]]:
            raise ValueError('This is not solely the supported identity rejection')
        output = item.get('outputPath') or ''
        tracked_path = PurePosixPath(output)
        if (not tracked_path.is_absolute() or '..' in tracked_path.parts or '\x00' in output
                or tracked_path not in {path, path.parent}):
            raise ValueError('Finished file differs from the tracked output path')
    candidate = candidates[0]
    validate_import_candidate(file, candidate, next(iter(downloads)))
    validate_import_entities(kind, queued, candidate, entities)
    return ordinary_import_command(kind, file, next(iter(downloads)))


def validate_import_entities(kind, queued, candidate, entities):
    key = 'movieId' if kind == 'radarr' else 'episodeId'
    expected = {item.get(key) for item in queued}
    if any(type(value) is not int or value <= 0 for value in expected):
        raise ValueError('Missing movie or episode identity')
    if {entity.get('id') for entity in entities} != expected or len(entities) != len(expected):
        raise ValueError('Entity readback differs from the tracked download')
    if any(type(entity.get('hasFile')) is not bool for entity in entities):
        raise ValueError('Current library file state is unknown')
    if kind == 'radarr':
        if len(expected) != 1 or candidate.get('movie', {}).get('id') not in expected:
            raise ValueError('Movie identity differs from import preview')
    else:
        series = {item.get('seriesId') for item in queued}
        episodes = candidate.get('episodes', [])
        if (len(series) != 1 or any(type(value) is not int or value <= 0 for value in series)
                or candidate.get('series', {}).get('id') not in series
                or {episode.get('id') for episode in episodes} != expected
                or len(episodes) != len(expected)
                or any(entity.get('seriesId') not in series for entity in [*entities, *episodes])):
            raise ValueError('Series or episode identities differ from import preview')
        positions = {(entity.get('seasonNumber'), entity.get('episodeNumber')) for entity in entities}
        if (len(positions) != len(expected)
                or positions != {(episode.get('seasonNumber'), episode.get('episodeNumber')) for episode in episodes}
                or any(type(season) is not int or season < 0 or type(episode) is not int or episode < 1
                       for season, episode in positions)):
            raise ValueError('Ambiguous season or episode numbering')


def prepare_identity_import(kind, file, download_id, read):
    """Read-only API preparation. Unknown or partially enumerated queues hold."""
    if kind not in IDENTITY_REJECTION or not isinstance(download_id, str) or not download_id:
        raise ValueError('A supported application and exact download identity are required')
    queue = read('queue?' + urlencode({'page': 1, 'pageSize': 1000}))
    records = queue.get('records', [])
    if queue.get('totalRecords') != len(records):
        raise ValueError('Queue enumeration is incomplete')
    queued = [item for item in records if item.get('downloadId') == download_id]
    candidates = read('manualimport?' + urlencode({
        'downloadId': download_id, 'filterExistingFiles': 'true',
    }))
    key, endpoint = ('movieId', 'movie/') if kind == 'radarr' else ('episodeId', 'episode/')
    ids = {item.get(key) for item in queued}
    if not ids or any(type(value) is not int or value <= 0 for value in ids):
        raise ValueError('Missing tracked entity identity')
    entities = [read(endpoint + str(value)) for value in sorted(ids)]
    command = identity_import_plan(kind, file, queued, candidates, entities)
    return {'command': command, 'entityKey': key, 'entityIds': sorted(ids)}


def prepare_path_import(kind, file, read):
    """An untracked, already published file still uses normal import decisions.

    The caller must prove publication first. No download identity is fabricated;
    an existing queue owner, rejection or ambiguous exact-file preview holds.
    """
    if kind not in IMPORT_COMMAND:
        raise ValueError('Unsupported Arr application')
    path = completed_media_path(file)
    queue = read('queue?page=1&pageSize=1000')
    rows = queue.get('records', [])
    if queue.get('totalRecords') != len(rows):
        raise ValueError('Queue enumeration is incomplete')
    if any(PurePosixPath(row.get('outputPath') or '') in {path, path.parent} for row in rows):
        raise ValueError('A tracked download owns this publication')
    candidates = read('manualimport?' + urlencode({'folder': str(path.parent), 'filterExistingFiles': 'true'}))
    selected = [candidate for candidate in candidates if candidate.get('path') == file]
    if len(selected) != 1:
        raise ValueError('Require one exact published import candidate')
    if any(candidate.get('path') != file and not candidate.get('rejections') for candidate in candidates):
        raise ValueError('Another accepted media file makes a package scan ambiguous')
    candidate = selected[0]
    validate_import_candidate(file, candidate, None)
    key, endpoint = ('movieId', 'movie/') if kind == 'radarr' else ('episodeId', 'episode/')
    expected = ([{'movieId': candidate.get('movie', {}).get('id')}] if kind == 'radarr' else
                [{'seriesId': candidate.get('series', {}).get('id'), 'episodeId': episode.get('id')}
                 for episode in candidate.get('episodes', [])])
    ids = {item[key] for item in expected}
    if not ids or any(type(value) is not int or value <= 0 for value in ids):
        raise ValueError('Preview has no known library entity identity')
    entities = [read(endpoint + str(value)) for value in sorted(ids)]
    validate_import_entities(kind, expected, candidate, entities)
    return {'command': ordinary_import_command(kind, file, None),
            'entityKey': key, 'entityIds': sorted(ids), 'sourceSize': candidate['size']}


def imported_files_match(kind, plan, events, read):
    by_entity = {entry.get(plan['entityKey']): entry for entry in events}
    if set(by_entity) != set(plan['entityIds']):
        return False
    for identity in plan['entityIds']:
        entity = read(('movie/' if kind == 'radarr' else 'episode/') + str(identity))
        if entity.get('id') != identity or entity.get('hasFile') is not True:
            return False
        if kind == 'radarr':
            media = entity.get('movieFile') or {}
        else:
            file_id = entity.get('episodeFileId')
            if type(file_id) is not int or file_id <= 0:
                return False
            media = read('episodefile/' + str(file_id))
            if media.get('id') != file_id:
                return False
        if (type(media.get('id')) is not int or media['id'] <= 0
                or type(media.get('size')) is not int or media['size'] <= 0
                or media.get('path') != by_entity[identity]['data']['importedPath']
                or ('sourceSize' in plan and media['size'] != plan['sourceSize'])):
            return False
        event_file = by_entity[identity]['data'].get('fileId')
        if event_file is not None and str(event_file) != str(media['id']):
            return False
    return True


def recover_import(kind, file, download_id, read, submit, receipt, timeout=120, interval=2):
    """Submit once and verify new import history; an uncertain submission holds.

    The caller owns the private receipt namespace and supplies the exact Arr
    connection. This is not enabled by the read-only audit.
    """
    if kind not in IMPORT_COMMAND or (download_id is not None and (not isinstance(download_id, str) or not download_id)):
        raise ValueError('Require a supported application and explicit tracked or untracked identity')
    prepare = (lambda: prepare_path_import(kind, file, read)) if download_id is None else (
        lambda: prepare_identity_import(kind, file, download_id, read))
    receipt = Path(receipt).absolute()
    if receipt.parent.resolve(strict=True) != receipt.parent:
        raise ValueError('Receipt parent must be a canonical owned directory')
    package = Path(file).absolute().parent
    if receipt.parent == package or package in receipt.parents:
        raise ValueError('Import receipts must be outside the removable media package')
    fd = os.open(receipt, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(fd, 'r+', encoding='utf-8') as journal:
        info = os.fstat(journal.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != os.geteuid() or info.st_mode & 0o077):
            raise ValueError('Unsafe import receipt')
        fcntl.flock(journal.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        raw = journal.read(65537)
        if len(raw) > 65536:
            raise ValueError('Import receipt exceeds its bound')
        records = [json.loads(line) for line in raw.splitlines()]
        intent = {'application': kind, 'file': file, 'downloadId': download_id}

        def record(value):
            journal.seek(0, os.SEEK_END)
            journal.write(json.dumps(value, sort_keys=True) + '\n')
            journal.flush()
            os.fsync(journal.fileno())
            parent = os.open(receipt.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)

        if records:
            plan, command_id, terminal = validate_import_records(records, kind, file, download_id)
            if terminal is not None:
                return terminal
        else:
            media = Path(file)
            if media.resolve(strict=True) != media or not media.is_file():
                raise ValueError('Completed media must be a canonical regular file')
            before = media.stat()
            plan = prepare()
            prior = read('history?page=1&pageSize=1000&sortKey=date&sortDirection=descending')
            prior_ids = [entry['id'] for entry in prior['records']]
            fresh = prepare()
            after = media.stat()
            fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
            if (fresh != plan or before.st_nlink != 1 or after.st_nlink != 1
                    or ('sourceSize' in plan and plan['sourceSize'] != before.st_size)
                    or any(getattr(after, key) != getattr(before, key) for key in fields)):
                raise ValueError('Import plan or completed file changed before submission')
            record({**intent, 'plan': plan, 'priorHistoryIds': prior_ids})
            response = submit(plan['command'])
            command_id = response.get('id')
            if type(command_id) is not int or command_id <= 0:
                raise ValueError('Import submission was not acknowledged; retain receipt')
            record({'commandId': command_id})
            records = [{**intent, 'plan': plan, 'priorHistoryIds': prior_ids}, {'commandId': command_id}]
        deadline = time.monotonic() + timeout
        status = None
        while time.monotonic() < deadline:
            command = read('command/' + str(command_id))
            history = read('history?page=1&pageSize=1000&sortKey=date&sortDirection=descending')
            imported = import_history_events(file, download_id, plan, records[0]['priorHistoryIds'], history['records'])
            status = command.get('status')
            if (status in {'completed', 'failed', 'aborted', 'cancelled'}
                    and imported_files_match(kind, plan, imported, read)):
                # Arr can fail in VerifyImport after committing the file and history.
                # Preserve that command outcome; never resubmit a proven import.
                result = {'imported': True, 'observationComplete': True, 'application': kind, 'commandId': command_id,
                          'entityIds': plan['entityIds'], 'commandStatus': status}
                if download_id is None:
                    result['resolvedDownloadIds'] = sorted({entry['downloadId'] for entry in imported if entry.get('downloadId')})
                record(result)
                return result
            time.sleep(interval)
        # A terminal command is not an import. Preserve a bounded negative
        # observation only while its exact published input remains available.
        # This closes that ACK without ever resubmitting its command.
        media = Path(file)
        if (status in {'completed', 'failed', 'aborted', 'cancelled'}
                and media.is_file() and not media.is_symlink() and media.stat().st_nlink == 1
                and plan.get('sourceSize') == media.stat().st_size):
            result = {'imported': False, 'observationComplete': True, 'application': kind,
                      'commandId': command_id, 'entityIds': plan['entityIds'], 'commandStatus': status,
                      'status': 'command-terminal-without-verified-import'}
            record(result)
            return result
        raise TimeoutError('Import is not yet proven; resume observation with the same receipt')


class PolicyError(RuntimeError):
    """A bounded diagnostic that contains no API payload or credentials."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def bounded_request(request, timeout):
    limit = 4 * 1024 * 1024
    with urllib.request.build_opener(NoRedirect).open(request, timeout=timeout) as response:
        body = response.read(limit + 1)
    if len(body) > limit:
        raise PolicyError('API response exceeds audit/configuration limit')
    return body


def arr_get(inputs, endpoint):
    request = urllib.request.Request(
        inputs['arr_host'].rstrip('/') + '/api/v3/' + endpoint,
        headers={'X-Api-Key': inputs['arr_api_key'], 'Accept': 'application/json'},
        method='GET',
    )
    return json.loads(bounded_request(request, timeout=15))


def arr_scan(inputs, command):
    """Only normal exact-path scans, with an optional real download identity."""
    if (inputs.get('arr') not in IMPORT_COMMAND
            or set(command) not in ({'name', 'path', 'downloadClientId', 'importMode'},
                                   {'name', 'path', 'importMode'})
            or command['name'] != IMPORT_COMMAND[inputs['arr']] or command['importMode'] != 'auto'):
        raise ValueError('Only a normal published-file import scan is allowed')
    if 'downloadClientId' in command:
        completed_media_path(command['path'])
    else:
        package = PurePosixPath(command['path'])
        if (not package.is_absolute() or len(package.parts) < 3 or '..' in package.parts
                or '\x00' in command['path'] or str(package) != command['path']):
            raise ValueError('An exact completed package directory is required')
    if 'downloadClientId' in command and (not isinstance(command['downloadClientId'], str) or not command['downloadClientId']):
        raise ValueError('A tracked scan requires its real download identity')
    request = urllib.request.Request(
        inputs['arr_host'].rstrip('/') + '/api/v3/command',
        data=json.dumps(command).encode(),
        headers={'X-Api-Key': inputs['arr_api_key'], 'Accept': 'application/json',
                 'Content-Type': 'application/json'}, method='POST',
    )
    return json.loads(bounded_request(request, timeout=15))
