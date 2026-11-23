"""Plugin publication history projection; no HTTP service.

Pinned Sonarr maps processing history statuses to Downloading and consumes
name/storage as title/path. Original SAB data and nzb_name stay unchanged.
"""

from copy import deepcopy
from pathlib import PurePosixPath


def validate_category(category):
    if (not isinstance(category, str) or not category.strip() or len(category) > 128
            or any(char in category for char in '\x00\r\n')):
        raise ValueError('Publication category must identify its configured media scope')
    return category


def project_history(response, publications, verify_committed):
    projected = deepcopy(response)
    slots = projected['history']['slots']
    if not isinstance(slots, list):
        raise ValueError('Invalid SAB history collection')
    seen = set()
    for slot in slots:
        download_id = slot.get('nzo_id')
        if download_id not in publications:
            continue
        if download_id in seen:
            raise ValueError('Duplicate registered download identity')
        seen.add(download_id)
        record = publications[download_id]
        validate_category(record['category'])
        if any(slot.get(key) != record[key] for key in ('category', 'name', 'storage')):
            raise ValueError('Downloader provenance differs from the registered publication')
        if slot.get('status') != 'Completed':
            continue
        if record['phase'] != 'committed':
            slot['status'] = 'Verifying'
            continue
        path = PurePosixPath(record['publishedStorage'])
        title = record['publishedName']
        if not isinstance(title, str) or not title or '/' in title or title in ('.', '..'):
            raise ValueError('Invalid published title')
        if not path.is_absolute() or '..' in path.parts or path.name != title:
            raise ValueError('Published storage must identify the exact release directory')
        if verify_committed(download_id, record) is not True:
            raise PermissionError('Publication has no verified committed package')
        slot['name'] = title
        slot['storage'] = str(path)
    return projected
