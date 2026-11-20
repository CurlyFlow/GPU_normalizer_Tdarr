"""Fresh, byte-proved candidate transport; unfinished owned copies are discarded."""

import os
from pathlib import Path
import stat

from media_history_store import canonical_root, private_json, retain_private
from media_package_transaction import move_exclusive, sync_directory
from tdarr_media_names import path_identity


def private_child(root, name):
    root = canonical_root(root)
    if Path(name).name != name or name in ('', '.', '..'):
        raise ValueError('Exact private child name is required')
    child = root / name
    child.mkdir(mode=0o700, exist_ok=True)
    canonical_root(child)
    info = child.stat()
    if info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError('Retention directory must be private and owned')
    sync_directory(root)
    return child


def copy_candidate(source, target, record, expected, assert_owner, checkpoint=lambda _: None):
    source, target, record = map(Path, (source, target, record))
    pending = target.with_suffix(target.suffix + '.pending')
    assert_owner()
    if list(path_identity(source)) != expected:
        raise ValueError('Admitted candidate changed before transport')
    if record.exists():
        retained = private_json(record)
        if (retained.get('source') != str(source) or retained.get('expected') != expected
                or retained.get('target') != str(target)
                or retained.get('identity') != list(path_identity(target))):
            raise ValueError('Retained candidate copy changed')
        return retained['identity']
    if not target.exists():
        available = os.statvfs(target.parent)
        if available.f_bavail * available.f_frsize < expected[4] + 64 * 1024 * 1024:
            raise ValueError('Insufficient private candidate transport capacity')
        if pending.exists() or pending.is_symlink():
            info = pending.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or info.st_uid != os.geteuid() or info.st_mode & 0o077
                    or pending.resolve(strict=True) != pending):
                raise ValueError('Unsafe interrupted candidate copy')
            if assert_owner() is not True:
                raise PermissionError('Exact copy ownership is required before discarding partial work')
            pending.unlink()
            sync_directory(pending.parent)
        descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as output, source.open('rb') as original:
            checkpoint('copy-start')
            for chunk in iter(lambda: original.read(1024 * 1024), b''):
                output.write(chunk)
                checkpoint('copy-chunk')
            output.flush()
            os.fsync(output.fileno())
        if list(path_identity(source)) != expected:
            raise ValueError('Admitted candidate changed during transport')
        actual = list(path_identity(pending))
        if actual[4] != expected[4] or actual[7] != expected[7]:
            raise ValueError('Candidate transport changed complete bytes')
        assert_owner()
        move_exclusive(pending, target)
        sync_directory(target.parent)
        checkpoint('copy-promoted')
    actual = list(path_identity(target))
    if (actual[4] != expected[4] or actual[7] != expected[7]
            or list(path_identity(source)) != expected):
        raise ValueError('Promoted candidate is not the admitted complete copy')
    retain_private(record, {'source': str(source), 'expected': expected,
                            'target': str(target), 'identity': actual})
    checkpoint('copy-record')
    return actual
