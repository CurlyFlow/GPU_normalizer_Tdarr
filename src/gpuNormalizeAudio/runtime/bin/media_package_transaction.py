"""Plugin publication transaction. No CLI; scheduler authorization is mandatory."""

import ctypes
import errno
import fcntl
import json
import os
import stat
from contextlib import ExitStack, contextmanager
from pathlib import Path


@contextmanager
def package_namespace(staging_root, completed_root):
    """Every terminal package owner locks the same canonical roots in order."""
    with ExitStack() as unwind:
        for root in sorted({Path(staging_root), Path(completed_root)}):
            if root.resolve(strict=True) != root or not root.is_dir():
                raise ValueError('Operation namespace is not canonical')
            descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            unwind.callback(os.close, descriptor)
            fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield


def move_exclusive(source, target):
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(target), 1):
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def identity(path):
    info = path.lstat()
    regular = stat.S_ISREG(info.st_mode) and info.st_nlink == 1
    empty_directory = stat.S_ISDIR(info.st_mode) and not any(path.iterdir())
    if not (regular or empty_directory):
        raise ValueError('Package entries must be unlinked regular files or empty directories')
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]


def component(value):
    if not isinstance(value, str) or value in ('', '.', '..') or '/' in value or '\x00' in value:
        raise ValueError('Expected a single path component')
    if len(os.fsencode(value)) > 240:
        raise ValueError('Package name exceeds the publication bound')
    return value


def publish_package(source, destination, journal, names, assert_owner, checkpoint=lambda _: None):
    """Resume one exact plan, never overwrite or undo an already published package.

    The scheduler must exclusively own the package and both parent namespaces.
    `assert_owner` must raise on lost authority, including during recovery.
    `checkpoint` is an internal crash-test hook, not a public execution mode.
    """
    source, destination, journal = (Path(path).absolute() for path in (source, destination, journal))
    for parent in (source.parent, destination.parent, journal.parent):
        if parent.resolve(strict=True) != parent:
            raise ValueError('Transaction parents must be canonical existing directories')
    if any(package == journal.parent or package in journal.parent.parents
           for package in (source, destination)):
        raise ValueError('Transaction journal must remain outside the package')
    for path in (source, destination, journal):
        component(path.name)
    names = {component(old): component(new) for old, new in names.items()}
    if not names or len(names) > 128 or len(set(names.values())) != len(names):
        raise ValueError('Invalid package mapping')
    if any(new in names and new != old for old, new in names.items()):
        raise ValueError('Overlapping package renames require a different plan')
    hidden = destination.parent / ('.publication-' + journal.name)
    if hidden in (source, destination):
        raise ValueError('Package conflicts with the transaction staging name')
    lock = os.open(str(journal) + '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('Unsafe transaction lock')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if assert_owner() is not True:
            raise PermissionError('Scheduler package ownership is not confirmed')
        intended = {'source': str(source), 'destination': str(destination), 'names': names}
        if journal.exists() or journal.is_symlink():
            fd = os.open(journal, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd) as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError('Unsafe transaction journal')
                raw = handle.read(65537)
            if len(raw) > 65536:
                raise ValueError('Transaction journal exceeds the bound')
            record = json.loads(raw)
            if any(record.get(key) != value for key, value in intended.items()):
                raise ValueError('Recovery plan differs from its durable journal')
        else:
            if ((destination != source and (destination.exists() or destination.is_symlink()))
                    or hidden.exists() or hidden.is_symlink()):
                raise FileExistsError(errno.EEXIST, 'Publication destination is occupied')
            if source.resolve(strict=True) != source or not source.is_dir():
                raise ValueError('Source package is not a canonical directory')
            if set(entry.name for entry in source.iterdir()) != set(names):
                raise ValueError('Package inventory differs from its plan')
            files = {name: identity(source / name) for name in names}
            if source.stat().st_dev != destination.parent.stat().st_dev:
                raise OSError(errno.EXDEV, 'Cross-filesystem publication is not supported')
            for name in names:
                fd = os.open(source / name, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            sync_directory(source)
            record = {**intended, 'directory': [source.stat().st_dev, source.stat().st_ino], 'files': files}
            temporary = journal.with_name(journal.name + '.new')
            fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as handle:
                json.dump(record, handle, sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
            move_exclusive(temporary, journal)
            sync_directory(journal.parent)
            checkpoint('journal')

        def owned_package():
            if assert_owner() is not True:
                raise PermissionError('Scheduler package ownership was lost')
            locations = [path for path in dict.fromkeys((source, hidden, destination))
                         if path.exists() or path.is_symlink()]
            if len(locations) != 1:
                raise ValueError('Ambiguous package location; automatic recovery refused')
            location = locations[0]
            info = location.lstat()
            if not stat.S_ISDIR(info.st_mode) or [info.st_dev, info.st_ino] != record['directory']:
                raise ValueError('Package directory identity changed')
            expected = set()
            for old, new in names.items():
                candidates = [name for name in dict.fromkeys((old, new))
                              if (location / name).exists() or (location / name).is_symlink()]
                if len(candidates) != 1 or identity(location / candidates[0]) != record['files'][old]:
                    raise ValueError('Package file changed or has an ambiguous recovery name')
                expected.add(candidates[0])
            if set(entry.name for entry in location.iterdir()) != expected:
                raise ValueError('Package inventory changed during publication')
            return location

        location = owned_package()
        if location == destination and set(entry.name for entry in location.iterdir()) == set(names.values()):
            return str(destination)
        if location == source:
            move_exclusive(source, hidden)
            sync_directory(source.parent)
            sync_directory(hidden.parent)
            checkpoint('hidden')
        elif location == destination:
            if set(entry.name for entry in destination.iterdir()) != set(names.values()):
                raise ValueError('Published package names contradict the journal')
            return str(destination)
        for old, new in names.items():
            owned_package()
            if old != new and (hidden / old).exists():
                move_exclusive(hidden / old, hidden / new)
                sync_directory(hidden)
                checkpoint('file:' + old)
        owned_package()
        move_exclusive(hidden, destination)
        sync_directory(destination.parent)
        checkpoint('published')
        return str(destination)
    finally:
        os.close(lock)
