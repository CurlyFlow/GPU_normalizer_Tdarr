"""Plugin admission and durable state for one Tdarr file job's final rename."""

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import stat
from itertools import islice

from media_package_transaction import move_exclusive, sync_directory, package_namespace
from tdarr_media_names import VIDEO

MEDIA_SUFFIXES = VIDEO | {'.mov', '.webm'}


def parse_min_file_size_bytes(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        raise ValueError('Minimum file size bound must be a non-negative number')
    return int(value)


def _staged_byte_size(original):
    stat_sync = original.get('statSync') if isinstance(original, dict) else None
    if isinstance(stat_sync, dict):
        size = stat_sync.get('size')
        if not isinstance(size, bool) and isinstance(size, (int, float)) and size >= 0:
            return int(size)
    file_size_mb = original.get('file_size') if isinstance(original, dict) else None
    if not isinstance(file_size_mb, bool) and isinstance(file_size_mb, (int, float)) and file_size_mb >= 0:
        return int(file_size_mb * 1024 * 1024)
    return None


class FlowOwnershipError(PermissionError):
    """Stable, path-free evidence; never collapse absent and conflicting owners."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class FlowAuthority:
    def __init__(self, job_file, library_id, state_root, read_staged, min_file_size_bytes=0,
                 allow_sibling_jobs=False):
        self.job_file = Path(job_file)
        if (not self.job_file.is_absolute() or '..' in self.job_file.parts
                or not isinstance(library_id, str) or not library_id):
            raise ValueError('Exact Tdarr job and library identities are required')
        self.library_id = library_id
        self.state_root = Path(state_root)
        self.read_staged = read_staged
        self.min_file_size_bytes = parse_min_file_size_bytes(min_file_size_bytes)
        self.allow_sibling_jobs = bool(allow_sibling_jobs)
        self.package_exclusive = not self.allow_sibling_jobs
        self._pruned_companions = set()
        self.active = False
        identity = hashlib.sha256(json.dumps([library_id, str(self.job_file)]).encode()).hexdigest()
        self.plan_path = self.state_root / (identity + '.plan')
        self.result_path = self.state_root / (identity + '.result')
        self.journal_path = self.state_root / (identity + '.journal')
        self.legacy_plan_path = self.plan_path
        self.publication_owner = None

    def bind_publication(self, completed_root):
        self.assert_owner()
        from media_publication_scope import publication_scope
        self.plan_path, self.publication_owner = publication_scope(
            self.library_id, self.job_file.parent, self.state_root,
            self.legacy_plan_path, completed_root)
        self.result_path = self.plan_path.with_suffix('.result')
        self.journal_path = self.plan_path.with_suffix('.journal')

    @contextmanager
    def acquire(self, package, staging_root, completed_root):
        package = Path(package)
        roots = sorted({Path(staging_root), Path(completed_root)})
        if self.active or package != self.job_file.parent:
            raise ValueError('Authority does not identify this package')
        root = self.state_root
        if (not root.is_absolute() or root.resolve(strict=True) != root
                or any(root == path or path in root.parents for path in roots)):
            raise ValueError('Private state must be outside all operation roots')
        info = root.stat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError('Private state directory ownership is unsafe')
        with package_namespace(staging_root, completed_root):
            self.active = True
            try:
                self.assert_owner()
                yield self
            finally:
                self.active = False

    def _package_entries(self, parent):
        with os.scandir(parent) as iterator:
            entries = [Path(entry.path) for entry in islice(iterator, 129)]
        if len(entries) > 128:
            raise ValueError('Companion inventory exceeds the package bound')
        return sorted(entries)

    def _job_meets_min_size(self, staged_self):
        try:
            info = self.job_file.lstat()
            return stat.S_ISREG(info.st_mode) and info.st_size >= self.min_file_size_bytes
        except FileNotFoundError:
            # During mkv->mp4 replacement, the job's original path may be replaced by its sibling output.
            recorded = _staged_byte_size(staged_self)
            return recorded is not None and recorded >= self.min_file_size_bytes

    def _is_below_min_staged_companion(self, path, original, staged_self):
        if self.min_file_size_bytes <= 0:
            return False
        path = Path(path)
        if path == self.job_file or path.parent != self.job_file.parent or path.suffix.lower() not in MEDIA_SUFFIXES:
            return False
        if not self._job_meets_min_size(staged_self):
            return False
        try:
            info = path.lstat()
        except FileNotFoundError:
            if path in self._pruned_companions:
                return True
            recorded = _staged_byte_size(original)
            return recorded is not None and recorded < self.min_file_size_bytes
        return stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size < self.min_file_size_bytes

    def _sibling_state_path(self, kind):
        parent = self.job_file.parent
        info = parent.stat()
        key = hashlib.sha256(json.dumps([self.library_id, str(parent), info.st_dev, info.st_ino]).encode()).hexdigest()
        return self.state_root / f'{key}.{kind}'

    def _read_sibling_map(self, kind):
        try:
            path = self._sibling_state_path(kind)
        except FileNotFoundError:
            return {}
        value = self._read(path)
        return value if isinstance(value, dict) else {}

    def _write_sibling_map(self, kind, mapping):
        path = self._sibling_state_path(kind)
        pending = path.with_suffix(path.suffix + '.pending')
        data = json.dumps(mapping, sort_keys=True).encode()
        if len(data) > 4 * 1024 * 1024:
            raise ValueError('Private sibling state is oversized')
        descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, path)
        sync_directory(path.parent)

    def _file_stamp(self, path):
        info = Path(path).lstat()
        return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]

    def mark_sibling_ready(self, file):
        self.assert_owner()
        target = Path(file)
        if target.parent != self.job_file.parent:
            raise ValueError('Sibling ready state differs from owned package')
        mapping = self._read_sibling_map('siblings-ready')
        stamp = self._file_stamp(target)
        mapping[str(target)] = stamp
        if target != self.job_file:
            mapping[str(self.job_file)] = {'replacedBy': str(target), 'stamp': stamp}
        self._write_sibling_map('siblings-ready', mapping)

    def mark_sibling_rejected(self, file):
        self.assert_owner()
        target = Path(file)
        if target.parent != self.job_file.parent:
            raise ValueError('Sibling rejection state differs from owned package')
        mapping = self._read_sibling_map('siblings-rejected')
        mapping[str(target)] = True
        self._write_sibling_map('siblings-rejected', mapping)

    def _is_settled_sibling_entry(self, entry, read_file, ready_map):
        record = read_file(str(entry)) if read_file is not None else None
        if (isinstance(record, dict) and record.get('_id') == str(entry)
                and record.get('DB') == self.library_id
                and record.get('TranscodeDecisionMaker') in {'Not required', 'Transcode success'}):
            return True
        expected = ready_map.get(str(entry))
        if isinstance(expected, list):
            try:
                return self._file_stamp(entry) == expected
            except FileNotFoundError:
                return False
        return False

    def sibling_media(self, file):
        self.assert_owner()
        target = Path(file)
        parent = target.parent
        if parent != self.job_file.parent:
            raise ValueError('Companion inventory differs from the owned package')
        return [entry for entry in self._package_entries(parent)
                if entry != target and entry.suffix.lower() in MEDIA_SUFFIXES]

    def partition_siblings(self, file, read_file):
        siblings = self.sibling_media(file)
        ready_map = self._read_sibling_map('siblings-ready')
        settled, pending = [], []
        for entry in siblings:
            if self._is_settled_sibling_entry(entry, read_file, ready_map):
                settled.append(str(entry))
            else:
                pending.append(str(entry))
        return settled, pending

    def _is_draining_settled_sibling(self, path):
        if path == self.job_file or path.parent != self.job_file.parent:
            return False
        rejected_map = self._read_sibling_map('siblings-rejected')
        if rejected_map.get(str(path)) is True and not path.exists():
            return True
        ready_map = self._read_sibling_map('siblings-ready')
        marker = ready_map.get(str(path))
        if isinstance(marker, dict) and isinstance(marker.get('replacedBy'), str):
            target = Path(marker['replacedBy'])
            try:
                return self._file_stamp(target) == marker.get('stamp')
            except FileNotFoundError:
                return False
        if isinstance(marker, list):
            try:
                return self._file_stamp(path) == marker
            except FileNotFoundError:
                return False
        return False

    def assert_owner(self, package_exclusive=None):
        if not self.active:
            raise PermissionError('Terminal rename lease is not held')
        exclusive = self.package_exclusive if package_exclusive is None else bool(package_exclusive)
        staged = self.read_staged()
        if not isinstance(staged, list):
            raise ValueError('Complete staged-job evidence is required')
        same_package = []
        staged_self = None
        for item in staged:
            original = item.get('originalLibraryFile', {})
            name = original.get('_id') if isinstance(original, dict) else None
            if not isinstance(name, str) or not Path(name).is_absolute():
                raise ValueError('Staged job has an unknown file identity')
            if Path(name).parent == self.job_file.parent:
                same_package.append((Path(name), original, item))
                if Path(name) == self.job_file and staged_self is None:
                    staged_self = original
        if exclusive:
            matching = [
                item for path, original, item in same_package
                if not (path != self.job_file and (
                    self._is_below_min_staged_companion(path, original, staged_self)
                    or (self.allow_sibling_jobs and self._is_draining_settled_sibling(path))
                ))
            ]
        else:
            matching = [item for path, _, item in same_package if path == self.job_file]
        if not matching:
            raise FlowOwnershipError('TDARR_OWNER_MISSING')
        if len(matching) > 1:
            raise FlowOwnershipError('TDARR_OWNER_CONFLICT')
        current = matching[0]
        original = current['originalLibraryFile']
        if (original['_id'] != str(self.job_file) or original.get('DB') != self.library_id
                or current.get('status') != 'processing'):
            raise FlowOwnershipError('TDARR_OWNER_MISMATCH')
        return True

    def prune_below_min_companions(self, file, remove_file=None):
        """Delete below-minimum sample/companion video files beside valid-sized media."""
        self.assert_owner()
        if self.min_file_size_bytes <= 0:
            return []
        target = Path(file)
        parent = target.parent
        if parent != self.job_file.parent:
            raise ValueError('Companion inventory differs from the owned package')
        if not parent.is_dir():
            return []
        try:
            target_info = target.lstat()
        except FileNotFoundError:
            return []
        if not stat.S_ISREG(target_info.st_mode) or target_info.st_size < self.min_file_size_bytes:
            return []
        pruned = []
        for entry in self._package_entries(parent):
            if entry == target or entry.suffix.lower() not in MEDIA_SUFFIXES:
                continue
            try:
                info = entry.lstat()
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size >= self.min_file_size_bytes:
                continue
            try:
                entry.unlink()
            except FileNotFoundError:
                pass
            self._pruned_companions.add(entry)
            pruned.append(str(entry))
        if pruned:
            sync_directory(parent)
            if remove_file is not None:
                for entry in pruned:
                    remove_file(entry)
        return pruned

    def companion_media(self, file, read_file):
        """Preserve explicitly finished/skipped companions; never move pending jobs."""
        self.assert_owner()
        parent = Path(file).parent
        if parent != self.job_file.parent:
            raise ValueError('Companion inventory differs from the owned package')
        companions = [entry for entry in self._package_entries(parent)
                      if entry != Path(file) and entry.suffix.lower() in MEDIA_SUFFIXES]
        ready_map = self._read_sibling_map('siblings-ready') if self.allow_sibling_jobs else {}
        for entry in companions:
            if not self._is_settled_sibling_entry(entry, read_file, ready_map):
                raise FlowOwnershipError('TDARR_COMPANION_PENDING')
        return [str(entry) for entry in companions]

    def _read(self, path):
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return None
        with os.fdopen(descriptor, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or info.st_uid != os.geteuid() or info.st_mode & 0o077):
                raise ValueError('Private rename state is unsafe')
            data = stream.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise ValueError('Private rename state is oversized')
            return json.loads(data)

    def _save(self, path, value):
        self.assert_owner()
        previous = self._read(path)
        if previous is not None:
            if previous != value:
                raise ValueError('Durable rename state cannot be replaced')
            return
        pending = path.with_suffix(path.suffix + '.pending')
        data = json.dumps(value, sort_keys=True).encode()
        if len(data) > 4 * 1024 * 1024:
            raise ValueError('Private rename state is oversized')
        descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        self.assert_owner()
        move_exclusive(pending, path)
        sync_directory(path.parent)

    def load_plan(self):
        self.assert_owner()
        return self._read(self.plan_path)

    def save_plan(self, plan):
        # JSON is also the retry contract (tuples become lists).
        self._save(self.plan_path, json.loads(json.dumps(plan)))

    def commit(self, result):
        self._save(self.result_path, result)
