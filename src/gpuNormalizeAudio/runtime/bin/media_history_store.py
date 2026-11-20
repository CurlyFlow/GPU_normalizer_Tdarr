"""Read-only SAB history adapter backed by the plugin's durable publication plans.

No downloader database writes, queue replays or import commands. Only an owned
plan registers a package. Its result and every content digest prove publication
before title and storage are exposed together.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import logging

from media_history_projection import project_history, validate_category
from media_package_transaction import identity as entry_identity, move_exclusive, sync_directory
from tdarr_media_names import package_identity


def private_json(path):
    path = Path(path)
    if path.resolve(strict=True) != path:
        raise ValueError('Private adapter state is not canonical')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != os.geteuid() or info.st_mode & 0o077):
            raise ValueError('Private adapter state ownership is unsafe')
        data = stream.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            raise ValueError('Private adapter state is oversized')
        return json.loads(data)


def canonical_root(value):
    path = Path(value)
    if not path.is_absolute() or path.resolve(strict=True) != path or not path.is_dir():
        raise ValueError('Adapter root is not canonical')
    return path


def retain_private(path, value):
    if path.exists():
        if private_json(path) != value:
            raise ValueError('Immutable adapter evidence differs')
        return
    pending = path.with_suffix(path.suffix + '.pending')
    descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(json.dumps(value, sort_keys=True).encode())
        stream.flush()
        os.fsync(stream.fileno())
    move_exclusive(pending, path)
    sync_directory(path.parent)


def publication_record_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def finished_media_digest(plan):
    finished = plan.get('evidence', {}).get('finishedIdentity')
    if (not isinstance(finished, list) or len(finished) != 8 or not isinstance(finished[-1], str)
            or len(finished[-1]) != 64 or any(char not in '0123456789abcdef' for char in finished[-1])):
        return None
    return finished[-1]


def package_metadata(parent):
    fields = ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
    result = {}
    for path in [parent, *parent.iterdir()]:
        info = path.lstat()
        if path == parent:
            valid = stat.S_ISDIR(info.st_mode)
        else:
            entry_identity(path)
            valid = True
        if not valid:
            raise ValueError('Committed package has unsafe entries')
        result[str(path)] = [getattr(info, field) for field in fields]
    return result


class PublicationHistory:
    def __init__(self, scopes, *, filesystem_root=None):
        self.filesystem_root = None
        if filesystem_root is not None:
            logical, local = filesystem_root
            logical = Path(logical)
            if not logical.is_absolute() or '..' in logical.parts:
                raise ValueError('Invalid logical media root')
            self.filesystem_root = (logical, canonical_root(local))
        if not isinstance(scopes, list) or not 1 <= len(scopes) <= 2:
            raise ValueError('Exact media scopes are required')
        self.scopes = []
        for value in scopes:
            if set(value) != {'category', 'stagingRoot', 'completedRoot', 'sabRoot', 'stateRoot'}:
                raise ValueError('Invalid adapter media scope')
            validate_category(value['category'])
            scope = dict(value)
            for key in ('stagingRoot', 'completedRoot', 'stateRoot'):
                logical = Path(scope[key])
                canonical_root(self.filesystem_path(logical))
                scope[key] = logical
            remote = Path(scope['sabRoot'])
            if not remote.is_absolute() or '..' in remote.parts:
                raise ValueError('Invalid downloader-visible root')
            scope['sabRoot'] = remote
            info = self.filesystem_path(scope['stateRoot']).stat()
            if info.st_uid != os.geteuid() or info.st_mode & 0o077:
                raise ValueError('Adapter publication state ownership is unsafe')
            if any(scope['category'] == previous['category'] for previous in self.scopes):
                raise ValueError('Ambiguous adapter category')
            self.scopes.append(scope)

    def filesystem_path(self, logical):
        if self.filesystem_root is None:
            return logical
        root, local = self.filesystem_root
        return local / logical.relative_to(root)

    def plans(self, scope):
        paths = sorted(self.filesystem_path(scope['stateRoot']).glob('*.plan'))
        if len(paths) > 1000:
            raise ValueError('Adapter plan inventory exceeds its bound')
        result = {}
        for path in paths:
            plan = private_json(path)
            source = Path(plan['source'])
            target = Path(plan['target'])
            if (source.parent.parent != scope['stagingRoot']
                    or target.parent.parent != scope['completedRoot']
                    or Path(plan['destination']) != target.parent
                    or Path(plan['journal']) != (scope['stateRoot'] / path.name).with_suffix('.journal')
                    or plan['names'].get(source.name) != target.name):
                raise ValueError('Publication plan escapes its configured scope')
            result.setdefault(source.parent.name, []).append((path, plan))
        return result

    def registered_plan(self, candidates, provenance, native_downloads):
        """Never let a folder reused by a new download inherit an old receipt."""
        matching, unregistered = [], []
        for path, plan in candidates:
            registration = path.with_suffix('.history-registration')
            if not registration.exists():
                unregistered.append((path, plan))
                continue
            retained = private_json(registration)
            if retained.get('nzo_id') == provenance['nzo_id']:
                if retained != provenance:
                    return None
                matching.append((path, plan))
        if len(matching) == 1 and not unregistered:
            return matching[0]
        eligible = matching + unregistered
        selected = eligible[0] if len(eligible) == 1 else self.verified_successor(eligible)
        if selected is None or native_downloads() != [provenance]:
            return None
        path, plan = selected
        if (self.filesystem_path(Path(plan['source']).parent).exists()
                or not path.with_suffix('.history-verified').exists()):
            return None
        retain_private(path.with_suffix('.history-registration'), provenance)
        return path, plan

    def verified_successor(self, candidates):
        """A committed retry may supersede only unfinished plans for the exact same media."""
        if any(path.with_suffix('.publication-correction').exists() for path, _ in candidates):
            return self.corrected_successor(candidates)
        committed = [(path, plan) for path, plan in candidates
                     if path.with_suffix('.result').exists() and path.with_suffix('.history-verified').exists()]
        if len(committed) != 1:
            return None
        path, plan = committed[0]
        finished = plan.get('evidence', {}).get('finishedIdentity')
        if finished_media_digest(plan) is None:
            return None
        for other_path, other in candidates:
            if other_path == path:
                continue
            if (other_path.with_suffix('.result').exists() or other_path.with_suffix('.history-verified').exists()
                    or any(other.get(key) != plan.get(key) for key in ('source', 'target'))
                    or other.get('evidence', {}).get('finishedIdentity') != finished):
                return None
        try:
            return (path, plan) if verify_committed(path, plan, self.filesystem_path) else None
        except (ValueError, OSError, KeyError, TypeError):
            return None

    def corrected_successor(self, candidates):
        """Switch an approved name correction atomically; keep every old plan immutable."""
        marked = [(path, plan) for path, plan in candidates if path.with_suffix('.publication-correction').exists()]
        if len(marked) != 1:
            return None
        path, plan = marked[0]
        try:
            correction = private_json(path.with_suffix('.publication-correction'))
            previous = [{'path': str(Path(other['journal']).with_suffix('.plan')),
                         'digest': publication_record_digest(other)}
                        for other_path, other in candidates if other_path != path]
            previous.sort(key=lambda item: item['path'])
            finished = finished_media_digest(plan)
            if (set(correction) != {'previous', 'result'} or not previous
                    or finished is None or plan.get('correctionOf') != previous
                    or correction['previous'] != previous
                    or correction['result'] != publication_record_digest(private_json(path.with_suffix('.result')))
                    or any(Path(other['source']).parent != Path(plan['source']).parent
                           or finished_media_digest(other) != finished
                           for other_path, other in candidates if other_path != path)
                    or not path.with_suffix('.history-verified').exists()):
                return None
            return (path, plan) if verify_committed(path, plan, self.filesystem_path) else None
        except (ValueError, OSError, KeyError, TypeError):
            return None

    def project(self, response, native_downloads):
        publications = {}
        for scope in self.scopes:
            plans = self.plans(scope)
            for slot in response['history']['slots']:
                if slot.get('category') != scope['category']:
                    continue
                storage = Path(slot.get('storage', ''))
                package = storage if storage.parent == scope['sabRoot'] else storage.parent
                registered = plans.get(package.name) if package.parent == scope['sabRoot'] else None
                if registered is None:
                    continue
                download_id = slot.get('nzo_id')
                if not isinstance(download_id, str) or not download_id:
                    raise ValueError('Registered history item lacks a download identity')
                provenance = {key: slot[key] for key in ('nzo_id', 'category', 'name', 'storage')}
                selected = self.registered_plan(registered, provenance,
                    lambda: native_downloads(scope['category'], package.name))
                phase, destination = 'waiting', ''
                if selected is not None:
                    path, plan = selected
                    destination = plan['destination']
                    try:
                        if (slot.get('status') == 'Completed'
                                and path.with_suffix('.history-verified').exists()
                                and verify_committed(path, plan, self.filesystem_path)):
                            phase = 'committed'
                    except (ValueError, OSError, KeyError, TypeError) as error:
                        # Keep this download non-importable, without poisoning the
                        # native history/UI or leaking paths/credentials in a log.
                        logging.warning('Tdarr publication held: %s (%s)', path.stem, type(error).__name__)
                publications[download_id] = {
                    'category': scope['category'], 'name': slot['name'], 'storage': slot['storage'],
                    'phase': phase, 'publishedStorage': destination,
                    'publishedName': Path(destination).name,
                }
        return project_history(response, publications, lambda *_: True)


def publication_metadata(logical, local):
    return {str(logical if Path(name) == local else logical / Path(name).name): value
            for name, value in package_metadata(local).items()}


def committed_publication_for_file(state_root, file, publication_path=None):
    """Exact publication admission for handoff/recovery, never a filename guess."""
    root = canonical_root(state_root)
    info = root.stat()
    if info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError('Unsafe publication receipt namespace')
    if publication_path is not None:
        selected = Path(publication_path)
        if (selected.parent != root or selected.suffix != '.plan' or len(selected.stem) != 64
                or any(value not in '0123456789abcdef' for value in selected.stem)):
            raise ValueError('Explicit publication receipt is outside its namespace')
        paths = [selected]
    else:
        paths = sorted(root.glob('*.plan'))
    if len(paths) > 1000:
        raise ValueError('Publication inventory exceeds its bound')
    matches = []
    for path in paths:
        if not path.with_suffix('.result').exists():
            continue
        result = private_json(path.with_suffix('.result'))
        if result.get('notifyPath') == str(file):
            matches.append((path, private_json(path), result))
    if len(matches) > 1:
        verified_matches = []
        for path, plan, result in matches:
            try:
                verified = path.with_suffix('.history-verified').exists() and verify_committed(path, plan)
            except (ValueError, OSError, KeyError, TypeError):
                verified = False
            if verified:
                verified_matches.append((path, plan, result))
        matches = verified_matches
    if len(matches) != 1:
        raise ValueError('Require one exact committed publication')
    path, plan, result = matches[0]
    if not path.with_suffix('.history-verified').exists() or not verify_committed(path, plan):
        raise ValueError('Independent publication proof is unavailable')
    return path, plan, result


def verify_committed(path, plan, filesystem_path=Path):
    receipt = path.with_suffix('.result')
    if not receipt.exists():
        return False
    result = private_json(receipt)
    target = Path(plan['target'])
    if (result['publishedStorage'] != plan['destination']
            or result['publishedName'] != target.parent.name
            or result['notifyPath'] != str(target)
            or result['moveDestination'] != str(target)
            or result['fileObjects']['inputFileObj']['_id'] != str(target)
            or Path(result['originalSource']).parent != Path(plan['source']).parent):
        raise ValueError('Committed result differs from the registered plan')
    digest = publication_record_digest([plan, result])
    verified_path = path.with_suffix('.history-verified')
    verified = private_json(verified_path) if verified_path.exists() else None
    if verified is not None and verified.get('identity') != digest:
        raise ValueError('Retained publication evidence differs from its plan')
    parent_path = filesystem_path(target.parent)
    if not parent_path.exists():
        return verified is not None
    metadata = publication_metadata(target.parent, parent_path)
    if verified is not None:
        retained = verified.get('metadata', {})
        parent = str(target.parent)
        if metadata == retained:
            return True
        # Ordinary import may consume proved entries. No replacement or changed
        # remaining entry is accepted; metadata uses logical names across mounts.
        if (not set(metadata) < set(retained)
                or metadata[parent][:3] != retained.get(parent, [])[:3]
                or any(value != retained.get(name) for name, value in metadata.items() if name != parent)):
            raise ValueError('Verified package changed after publication')
        return True
    actual = package_identity(parent_path)
    expected = plan['evidence']['packageIdentity']
    if set(actual) != {str(parent_path), *(str(parent_path / name) for name in plan['names'].values())}:
        raise ValueError('Committed package inventory differs from the plan')
    for original, name in plan['names'].items():
        before = expected[str(Path(plan['source']).parent / original)]
        after = actual[str(parent_path / name)]
        if tuple(before[:6]) != tuple(after[:6]) or before[7] != after[7]:
            raise ValueError('Committed package differs from its media evidence')
    if publication_metadata(target.parent, parent_path) != metadata:
        raise ValueError('Committed package changed during verification')
    retain_private(verified_path, {'identity': digest, 'metadata': metadata})
    return True
