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


class FlowOwnershipError(PermissionError):
    """Stable, path-free evidence; never collapse absent and conflicting owners."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class FlowAuthority:
    def __init__(self, job_file, library_id, state_root, read_staged):
        self.job_file = Path(job_file)
        if (not self.job_file.is_absolute() or '..' in self.job_file.parts
                or not isinstance(library_id, str) or not library_id):
            raise ValueError('Exact Tdarr job and library identities are required')
        self.library_id = library_id
        self.state_root = Path(state_root)
        self.read_staged = read_staged
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

    def assert_owner(self):
        if not self.active:
            raise PermissionError('Terminal rename lease is not held')
        staged = self.read_staged()
        if not isinstance(staged, list):
            raise ValueError('Complete staged-job evidence is required')
        matching = []
        for item in staged:
            original = item.get('originalLibraryFile', {})
            name = original.get('_id') if isinstance(original, dict) else None
            if not isinstance(name, str) or not Path(name).is_absolute():
                raise ValueError('Staged job has an unknown file identity')
            if Path(name).parent == self.job_file.parent:
                matching.append(item)
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

    def companion_media(self, file, read_file):
        """Preserve explicitly finished/skipped companions; never move pending jobs."""
        self.assert_owner()
        parent = Path(file).parent
        if parent != self.job_file.parent:
            raise ValueError('Companion inventory differs from the owned package')
        with os.scandir(parent) as iterator:
            entries = [Path(entry.path) for entry in islice(iterator, 129)]
        if len(entries) > 128:
            raise ValueError('Companion inventory exceeds the package bound')
        companions = sorted(entry for entry in entries if entry != Path(file) and entry.suffix.lower() in VIDEO)
        for entry in companions:
            record = read_file(str(entry)) if read_file is not None else None
            if (not isinstance(record, dict) or record.get('_id') != str(entry)
                    or record.get('DB') != self.library_id
                    or record.get('TranscodeDecisionMaker') not in {'Not required', 'Transcode success'}):
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
