"""Receive private connection details on stdin, never in command arguments."""
import json
import sys
import time
import os
from pathlib import Path
from urllib.parse import urlsplit

from arr_import_recovery import (IDENTITY_REJECTION, arr_get, arr_scan, recover_import,
                                 import_receipt_path, read_import_receipt, validate_import_records)
from media_history_store import committed_publication_for_file


def import_receipt(inputs, file, download_id, root):
    root.mkdir(mode=0o700, exist_ok=True)
    if (root.resolve(strict=True) != root or not root.is_dir()
            or root.stat().st_uid != os.geteuid() or root.stat().st_mode & 0o077):
        raise ValueError('Unsafe receipt namespace')
    return import_receipt_path(inputs, file, download_id, root)


def recover_from_queue(inputs, file, receipt_directory, publication_directory, publication_path=None):
    media = Path(file)
    root = Path(receipt_directory)
    if (not media.is_absolute() or '..' in media.parts or not root.is_absolute()
            or root.parent.resolve(strict=True) != root.parent
            or root == media.parent or media.parent in root.parents):
        raise ValueError('Require canonical media and an independent persistent receipt directory')
    committed_publication_for_file(publication_directory, file, publication_path)
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        queue = arr_get(inputs, 'queue?page=1&pageSize=1000')
        rows = queue.get('records', [])
        if queue.get('totalRecords') != len(rows):
            raise ValueError('Queue enumeration is incomplete')
        matches = [row for row in rows if Path(row.get('outputPath') or '') in {media, media.parent}]
        blocked = [row for row in matches if row.get('trackedDownloadState') == 'importBlocked']
        if blocked:
            ids = {row.get('downloadId') for row in matches}
            reasons = [[reason for issue in row.get('statusMessages', []) for reason in issue.get('messages', [])]
                       for row in blocked]
            if any(value != [IDENTITY_REJECTION[inputs['arr']]] for value in reasons):
                return {'imported': False, 'recoveryRequired': False, 'status': 'ordinary-import-rejection'}
            if len(ids) != 1 or not all(isinstance(value, str) and value for value in ids):
                raise ValueError('Ambiguous published download identity')
            download_id = next(iter(ids))
            receipt = import_receipt(inputs, file, download_id, root)
            return recover_import(inputs['arr'], file, download_id,
                lambda endpoint: arr_get(inputs, endpoint), lambda command: arr_scan(inputs, command), receipt)
        if not media.exists():
            return {'imported': False, 'recoveryRequired': False, 'status': 'published-source-no-longer-present'}
        time.sleep(2)
    path, _, _ = committed_publication_for_file(publication_directory, file, publication_path)
    if path.with_suffix('.history-registration').exists():
        return {'imported': False, 'recoveryRequired': False, 'status': 'no-identity-rejection-observed'}
    # The ordinary queue grace expired. A proved publication without a native
    # attempt can use its release-folder scan only with one accepted primary.
    # Observe the concrete old file-scan ACK before starting the distinct
    # package-scoped command; unknown or active submissions never get retried.
    legacy = import_receipt_path(inputs, file, None, root, legacy=True)
    if legacy.exists():
        _, _, terminal = validate_import_records(read_import_receipt(legacy), inputs['arr'], file, None)
        if terminal is None or terminal['imported']:
            return recover_import(inputs['arr'], file, None,
                lambda endpoint: arr_get(inputs, endpoint), lambda command: arr_scan(inputs, command), legacy)
    return recover_import(inputs['arr'], file, None,
        lambda endpoint: arr_get(inputs, endpoint), lambda command: arr_scan(inputs, command),
        import_receipt(inputs, file, None, root))


def recover_request(request):
    required = {'application', 'host', 'apiKey', 'file', 'downloadId', 'receipt'}
    automatic = {'application', 'host', 'apiKey', 'file', 'receiptDirectory', 'publicationDirectory'}
    if not isinstance(request, dict) or set(request) not in (required, automatic, automatic | {'publicationPlan'}):
        raise ValueError('Invalid published-file recovery request')
    fields = {key: value for key, value in request.items() if not (key == 'downloadId' and value is None)}
    if any(not isinstance(value, str) or not value or '\x00' in value for value in fields.values()):
        raise ValueError('Recovery request fields must be nonempty strings')
    host = urlsplit(request['host'])
    if (host.scheme not in {'http', 'https'} or not host.hostname or host.username or host.password
            or host.query or host.fragment or request['application'] not in IDENTITY_REJECTION
            or not Path(request.get('receipt', request.get('receiptDirectory', ''))).is_absolute()):
        raise ValueError('An explicit HTTP service and absolute receipt path are required')
    inputs = {'arr': request['application'], 'arr_host': request['host'], 'arr_api_key': request['apiKey']}
    if 'receiptDirectory' in request:
        return recover_from_queue(inputs, request['file'], request['receiptDirectory'],
                                  request['publicationDirectory'], request.get('publicationPlan'))
    if request['downloadId'] is None and not Path(request['receipt']).stat().st_size:
        raise ValueError('An untracked resume requires a retained submission receipt')
    return recover_import(
        request['application'], request['file'], request['downloadId'],
        lambda endpoint: arr_get(inputs, endpoint), lambda command: arr_scan(inputs, command),
        request['receipt'],
    )


if __name__ == '__main__':
    try:
        if len(sys.argv) != 1:
            raise ValueError('Recovery accepts stdin only')
        payload = sys.stdin.buffer.read(32769)
        if len(payload) > 32768:
            raise ValueError('Recovery request exceeds its bound')
        print(json.dumps(recover_request(json.loads(payload))))
    except Exception as error:
        # API errors and filesystem exceptions can contain private paths or credentials.
        print(json.dumps({'error': type(error).__name__, 'imported': False}))
        sys.exit(1)
