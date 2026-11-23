"""Native SAB consumer for rejection requests from the active Tdarr plugin."""
import hashlib
import json
import fcntl
import os
from contextlib import contextmanager
from pathlib import Path
import stat

from media_history_store import private_json, retain_private, publication_record_digest, verify_committed


IDENTITY = ('nzo_id', 'name', 'category', 'storage')


class InactiveSender(ValueError):
    """A retained request is dormant until its plugin invocation resumes."""


@contextmanager
def rejection_lease(path):
    """Only a live plugin invocation may authorize an unacknowledged request."""
    fd = os.open(path.with_suffix('.rejection-live'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid():
            raise ValueError('Invalid rejection lease file')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def require_live_sender(path):
    try:
        with rejection_lease(path):
            raise InactiveSender('Plugin rejection sender is no longer active')
    except BlockingIOError:
        return


def failure_message(request):
    size_reasons = {'belowMinimum': 'below the configured minimum file size',
                    'aboveMaximum': 'above the configured maximum file size',
                    'unreadableMedia': 'FFmpeg cannot read the media after stream-copy recovery',
                    'notQualityUpgrade': 'verified new media does not improve the existing library version'}
    if request['reason'] in size_reasons:
        if request['selectedLanguages'] != []:
            raise ValueError('Non-language rejection must not contain audio selection')
        return 'Tdarr rejected download: ' + size_reasons[request['reason']] + '.'
    if request['reason'] == 'noAudioStreams':
        return 'Tdarr rejected download: no audio streams.'
    if request['reason'] != 'noSelectedAudio':
        raise ValueError('Unknown plugin rejection reason')
    languages = request['selectedLanguages']
    if (not isinstance(languages, list) or not languages or len(languages) > 32
            or any(not isinstance(value, str) or not value.isalpha() or not 2 <= len(value) <= 3
                   for value in languages)):
        raise ValueError('Invalid rejected audio language selection')
    return 'Tdarr rejected download: no audio matches selected languages (' + ', '.join(languages) + ').'


def source_identity(path):
    path = Path(path)
    if path.resolve(strict=True) != path:
        raise ValueError('Rejected source must be canonical')
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('Rejected source must be a single-link regular file')
    return {key: str(getattr(info, key)) for key in ('st_ino', 'st_size', 'st_mtime_ns')}


def request_key(request):
    return hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()


def validate_request(request, scope, path):
    fields = {'source', 'sourceIdentity', 'reason', 'selectedLanguages'}
    completed = request.get('reason') == 'notQualityUpgrade'
    if set(request) != (fields | {'publication'} if completed else fields):
        raise ValueError('Invalid plugin rejection request')
    source = Path(request['source'])
    root = scope['completedRoot'] if completed else scope['stagingRoot']
    if source.parent.parent != root or '..' in source.parts:
        raise ValueError('Plugin rejection is outside the configured package scope')
    if path.name != request_key(request) + '.rejection-request':
        raise ValueError('Rejection request filename differs from its downloader identity')
    return failure_message(request)


def resolve_published_download(owner, connection, request, scope):
    """A completed source needs immutable publication provenance, not its new name."""
    reference = request['publication']
    if not isinstance(reference, dict) or set(reference) != {'plan', 'planDigest', 'resultDigest', 'registrationDigest'}:
        raise ValueError('Completed rejection has no exact publication reference')
    logical = Path(reference['plan'])
    if (logical.parent != scope['stateRoot'] or len(logical.stem) != 64
            or any(char not in '0123456789abcdef' for char in logical.stem) or logical.suffix != '.plan'):
        raise ValueError('Completed rejection publication is outside its state namespace')
    path = owner.filesystem_path(logical)
    plan = private_json(path)
    result = private_json(path.with_suffix('.result'))
    registration = private_json(path.with_suffix('.history-registration'))
    if (any(publication_record_digest(value) != reference[key] for key, value in
            [('planDigest', plan), ('resultDigest', result), ('registrationDigest', registration)])
            or plan['target'] != request['source'] or Path(plan['source']).parent.parent != scope['stagingRoot']
            or not path.with_suffix('.history-verified').exists()
            or not verify_committed(path, plan, owner.filesystem_path)):
        raise ValueError('Completed rejection differs from its proved publication')
    package = Path(plan['source']).parent.name
    storage = Path(registration['storage'])
    if (registration['name'] != package or registration['category'] != scope['category']
            or not storage.is_absolute() or '..' in storage.parts
            or (storage != scope['sabRoot'] / package and storage.parent != scope['sabRoot'] / package)):
        raise ValueError('Publication native identity escapes its configured package')
    rows = connection.execute('SELECT ' + ','.join(IDENTITY) + ' FROM history WHERE nzo_id=?',
                              (registration['nzo_id'],)).fetchall()
    if len(rows) != 1:
        raise ValueError('Completed publication has no unique native downloader row')
    sab = dict(rows[0]) if hasattr(rows[0], 'keys') else dict(zip(IDENTITY, rows[0]))
    if any(sab[key] != registration[key] for key in IDENTITY):
        raise ValueError('Native row differs from the registered publication attempt')
    return sab


def resolve_native_download(connection, request, scope):
    source = Path(request['source'])
    package = source.parent.name
    rows = connection.execute('SELECT ' + ','.join(IDENTITY) +
                              ' FROM history WHERE name=? AND category=? AND archive IS NULL',
                              (package, scope['category'])).fetchall()
    if len(rows) != 1:
        raise ValueError('Rejected package has no unique native downloader identity')
    sab = dict(rows[0]) if hasattr(rows[0], 'keys') else dict(zip(IDENTITY, rows[0]))
    if Path(sab['storage']) not in {scope['sabRoot'] / package, scope['sabRoot'] / package / source.name}:
        raise ValueError('Native downloader storage does not identify the rejected package')
    return sab


def mark_native_failed(connection, sab, message, retain_original, original):
    """One native history row, with original evidence retained before commit."""
    columns = (*IDENTITY, 'status', 'fail_message', 'archive')
    connection.execute('BEGIN IMMEDIATE')
    try:
        rows = connection.execute('SELECT ' + ','.join(columns) + ' FROM history WHERE nzo_id = ?',
                                  (sab['nzo_id'],)).fetchall()
        if len(rows) != 1:
            raise ValueError('Native SAB history identity is missing or ambiguous')
        row = dict(rows[0]) if hasattr(rows[0], 'keys') else dict(zip(columns, rows[0]))
        if any(row[key] != sab[key] for key in IDENTITY):
            raise ValueError('Native SAB provenance changed')
        if row['status'] == 'Failed' and row['fail_message'] == message:
            if (not isinstance(original, dict) or original.get('status') != 'Completed'
                    or original.get('archive') is not None
                    or any(original.get(key) != row[key] for key in IDENTITY)):
                raise ValueError('Native failure has no original receipt for this input attempt')
            connection.rollback()
            return
        if row['status'] != 'Completed' or row['archive'] is not None:
            raise ValueError('Native SAB download is not terminal Completed')
        retain_original(row)
        changed = connection.execute('UPDATE history SET status=?, fail_message=? WHERE nzo_id=? AND status=? AND archive IS NULL',
                                     ('Failed', message, sab['nzo_id'], 'Completed'))
        if changed.rowcount != 1:
            raise ValueError('Native SAB rejection did not change exactly one row')
        connection.commit()
    except BaseException:
        connection.rollback()
        raise


def consume_rejection(owner, connection, active_path, scope, path):
    request = private_json(path)
    message = validate_request(request, scope, path)
    receipt = path.with_suffix('.rejection-result')
    if receipt.exists():
        retained = private_json(receipt)
        if (retained.get('request') != request or retained.get('status') != 'Failed'
                or retained.get('fail_message') != message):
            raise ValueError('Native rejection receipt differs')
        return 0
    require_live_sender(path)
    if source_identity(owner.filesystem_path(Path(request['source']))) != request['sourceIdentity']:
        raise ValueError('Rejected source has changed')
    sab = (resolve_published_download(owner, connection, request, scope)
           if request['reason'] == 'notQualityUpgrade' else resolve_native_download(connection, request, scope))
    if active_path(sab['nzo_id']):
        raise ValueError('Native SAB download is still active')
    original_path = path.with_suffix('.rejection-original')
    original = private_json(original_path) if original_path.exists() else None
    mark_native_failed(connection, sab, message,
                       lambda row: retain_private(original_path, row), original)
    result = {'request': request, 'sab': sab, 'status': 'Failed', 'fail_message': message}
    retain_private(receipt, result)
    return 1


def reconcile_rejections(owner, connection, active_path):
    processed = 0
    for scope in owner.scopes:
        paths = sorted(path for path in owner.filesystem_path(scope['stateRoot']).glob('*.rejection-request')
                       if not path.with_suffix('.rejection-result').exists()
                       and not path.with_suffix('.rejection-error').exists())
        if len(paths) > 1000:
            raise ValueError('Plugin rejection inventory exceeds its bound')
        for path in paths:
            error_path = path.with_suffix('.rejection-error')
            if error_path.exists():
                continue
            try:
                processed += consume_rejection(owner, connection, active_path, scope, path)
            except InactiveSender:
                continue
            except (ValueError, OSError, KeyError, TypeError) as error:
                # A held Tdarr job must not break native history for other downloads.
                retain_private(error_path, {'error': type(error).__name__})
    return processed
