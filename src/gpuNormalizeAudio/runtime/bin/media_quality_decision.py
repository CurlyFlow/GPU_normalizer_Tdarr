"""Observe Arr's current non-upgrade decision; never implement its scoring rules."""
from pathlib import Path
import re
from urllib.parse import urlencode

from tdarr_media_names import probe_naming_facts


QUALITY_REASON = re.compile(
    r'^Not a Custom Format upgrade for existing (?:movie|episode) file\(s\)\. '
    r'New: \[(.*?)\] \((-?\d+)\) do not improve on Existing: \[(.*?)\] \((-?\d+)\)$')


def quality_reason(value):
    match = QUALITY_REASON.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise ValueError('Not solely the supported native non-upgrade decision')
    new_formats, new_score, old_formats, old_score = match.groups()
    if int(new_score) > int(old_score):
        raise ValueError('Observed new custom-format score is better')
    return {'reason': value, 'newScore': int(new_score), 'existingScore': int(old_score),
            'newFormats': new_formats.split(', ') if new_formats else [],
            'existingFormats': old_formats.split(', ') if old_formats else []}


def library_file(kind, entity, read):
    key = 'movieFile' if kind == 'radarr' else 'episodeFile'
    file_id = entity.get(key + 'Id') or entity.get(key, {}).get('id')
    if entity.get('hasFile') is not True or type(file_id) is not int or file_id <= 0:
        raise ValueError('Existing better library file is not identified')
    file = read(('moviefile/' if kind == 'radarr' else 'episodefile/') + str(file_id))
    if (file.get('id') != file_id or not isinstance(file.get('path'), str) or not file['path']
            or type(file.get('size')) is not int or file['size'] <= 0):
        raise ValueError('Existing library file readback is incomplete')
    # The library can live on another host/mount. Never open, modify or delete
    # this path; its configured Arr identity and readback own this observation.
    return {key: file.get(key) for key in ('id', 'path', 'size', 'quality', 'mediaInfo',
                'languages', 'customFormats', 'customFormatScore', 'dateAdded')}


def observed_score(formats, profile, definitions):
    if not isinstance(formats, list) or len(formats) > 1000:
        raise ValueError('Applied custom formats are unknown')
    weights = {item['format']: item['score'] for item in profile['formatItems']}
    known = {item['id']: item['name'] for item in definitions}
    ids = [item['id'] for item in formats]
    if (len(set(ids)) != len(ids) or any(item.get('name') != known.get(item['id'])
            or type(weights.get(item['id'])) is not int for item in formats)):
        raise ValueError('Applied custom formats differ from current configured rules')
    return sum(weights[value] for value in ids)


def non_upgrade_rows(file, publication, registration, queue):
    """A missing/other decision is pending, never permission to reject."""
    file = Path(file)
    rows = queue.get('records', [])
    if queue.get('totalRecords') != len(rows) or len(rows) > 1000:
        raise ValueError('Current queue evidence is incomplete')
    matches = [row for row in rows if row.get('downloadId') == registration['nzo_id']]
    for row in matches:
        reasons = [message for item in row.get('statusMessages', []) for message in item.get('messages', [])]
        if (row.get('status') != 'completed' or row.get('trackedDownloadState') not in {'importPending', 'importBlocked'}
                or Path(row.get('outputPath') or '') not in {file, file.parent}
                or row.get('title') != publication['publishedName'] or len(reasons) != 1):
            return []
        if QUALITY_REASON.fullmatch(reasons[0]) is None:
            return []
        quality_reason(reasons[0])
    return matches


def file_import_assessment(kind, file, matches, read):
    """Bind native import assessment, not release queue formats, to this file."""
    preview = read('manualimport?' + urlencode({'folder': str(file.parent), 'filterExistingFiles': 'true'}))
    if not isinstance(preview, list) or len(preview) > 1000:
        raise ValueError('File import preview is incomplete')
    candidates = [item for item in preview if item.get('path') == str(file)]
    if len(candidates) != 1:
        raise ValueError('File import preview has no unique exact file')
    candidate = candidates[0]
    reasons = {message for row in matches for item in row['statusMessages'] for message in item.get('messages', [])}
    rejections = candidate.get('rejections')
    if (candidate.get('existingFile') is True or type(candidate.get('size')) is not int
            or candidate['size'] <= 0 or candidate['size'] != file.stat().st_size
            or not isinstance(rejections, list) or len(rejections) != 1
            or {item.get('reason') for item in rejections} != reasons):
        raise ValueError('Exact file import assessment differs from native rejection')
    entity_key = 'movieId' if kind == 'radarr' else 'episodeId'
    expected_ids = {row.get(entity_key) for row in matches}
    if not expected_ids or any(type(value) is not int or value <= 0 for value in expected_ids):
        raise ValueError('File import entity identity is unknown')
    if kind == 'radarr':
        if expected_ids != {candidate.get('movie', {}).get('id')}:
            raise ValueError('File import movie identity differs')
    else:
        episodes = candidate.get('episodes')
        if (not isinstance(episodes, list) or len(episodes) != len(expected_ids)
                or {item.get('id') for item in episodes} != expected_ids
                or {item.get('seriesId') for item in episodes} != {row.get('seriesId') for row in matches}
                or any(type(item.get('seriesId')) is not int or item['seriesId'] <= 0 for item in episodes)):
            raise ValueError('File import episode or series identity differs')
    return {'path': str(file), 'size': candidate['size'], 'entityKey': entity_key,
            'entityIds': sorted(expected_ids), 'quality': candidate.get('quality'),
            'customFormats': candidate.get('customFormats'), 'customFormatScore': candidate.get('customFormatScore')}


def quality_snapshot(kind, file, publication, registration, read):
    if kind not in {'radarr', 'sonarr'}:
        raise ValueError('Unsupported Arr application')
    file = Path(file)
    matches = non_upgrade_rows(file, publication, registration, read('queue?page=1&pageSize=1000'))
    if not matches:
        raise ValueError('No sole current native non-upgrade owner')
    imported = file_import_assessment(kind, file, matches, read)
    entity_key = 'movieId' if kind == 'radarr' else 'episodeId'
    observations = []
    for row in matches:
        scores = quality_reason(next(message for item in row['statusMessages'] for message in item.get('messages', [])))
        entity_id = row.get(entity_key)
        if type(entity_id) is not int or entity_id <= 0:
            raise ValueError('Missing exact library entity')
        entity = read(('movie/' if kind == 'radarr' else 'episode/') + str(entity_id))
        if entity.get('id') != entity_id:
            raise ValueError('Current library entity changed')
        profile_id = entity.get('qualityProfileId')
        if kind == 'sonarr':
            series = read('series/' + str(entity.get('seriesId')))
            if series.get('id') != row.get('seriesId'):
                raise ValueError('Series identity differs')
            profile_id = series.get('qualityProfileId')
        if type(profile_id) is not int or profile_id <= 0:
            raise ValueError('Quality profile is unknown')
        profile = read('qualityprofile/' + str(profile_id))
        definitions = read('customformat')
        if profile.get('id') != profile_id or not isinstance(definitions, list) or len(definitions) > 1000:
            raise ValueError('Observed scoring rules are incomplete')
        existing = library_file(kind, entity, read)
        if (type(existing.get('customFormatScore')) is not int
                or existing['customFormatScore'] != scores['existingScore']
                or type(imported['customFormatScore']) is not int or imported['customFormatScore'] != scores['newScore']
                or observed_score(imported['customFormats'], profile, definitions) != scores['newScore']
                or observed_score(row.get('customFormats'), profile, definitions) != row.get('customFormatScore')
                or observed_score(existing.get('customFormats'), profile, definitions) != scores['existingScore']
                or set(scores['newFormats']) != {item['name'] for item in imported['customFormats']}
                or set(scores['existingFormats']) != {item['name'] for item in existing['customFormats']}):
            raise ValueError('Rejection scores do not reconcile current applied formats and profile rules')
        if Path(existing['path']) in {file, file.parent} or file.parent in Path(existing['path']).parents:
            raise ValueError('Existing library file overlaps the rejected package')
        observations.append({'entityKey': entity_key, 'entityId': entity_id,
            'seriesId': row.get('seriesId') if kind == 'sonarr' else None,
            'downloadId': registration['nzo_id'], 'outputPath': str(file.parent), **scores,
            'newQuality': imported['quality'], 'newCustomFormats': imported['customFormats'],
            'fileImportAssessment': imported,
            'queueReleaseAssessment': {key: row.get(key) for key in ('quality', 'customFormats', 'customFormatScore')},
            'existingFile': existing, 'qualityProfile': profile, 'customFormatDefinitions': definitions})
    if len({item['entityId'] for item in observations}) != len(observations):
        raise ValueError('Duplicate library entities in rejection evidence')
    return {'application': kind, 'observations': observations}


def proved_quality_decision(kind, file, plan, publication, registration, read, ffprobe='ffprobe'):
    actual = probe_naming_facts(file, ffprobe)
    if actual != plan.get('evidence', {}).get('facts'):
        raise ValueError('Published technical facts are stale; correct them before quality rejection')
    return {'actualMedia': actual,
            'arr': quality_snapshot(kind, file, publication, registration, read)}


def assert_library_unchanged(snapshot, read):
    """After native ACK the tracked queue may disappear; existing files must not."""
    kind = snapshot['application']
    for item in snapshot['observations']:
        entity = read(('movie/' if kind == 'radarr' else 'episode/') + str(item['entityId']))
        profile_id = entity.get('qualityProfileId')
        if kind == 'sonarr':
            series = read('series/' + str(item['seriesId']))
            if entity.get('seriesId') != item['seriesId'] or series.get('id') != item['seriesId']:
                raise ValueError('Existing series association changed before cleanup')
            profile_id = series.get('qualityProfileId')
        if (entity.get('id') != item['entityId'] or library_file(kind, entity, read) != item['existingFile']
                or profile_id != item['qualityProfile']['id']
                or read('qualityprofile/' + str(item['qualityProfile']['id'])) != item['qualityProfile']
                or read('customformat') != item['customFormatDefinitions']):
            raise ValueError('Existing library file or configured rules changed before cleanup')
