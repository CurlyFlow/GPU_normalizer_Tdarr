"""Owned file replacement with durable original retention. No CLI or cleanup.

This proves storage transitions only. The caller must separately verify intended
media transformations and hold exact source/candidate/destination authority.
"""

import fcntl
import os
from pathlib import Path
import stat

from media_history_store import canonical_root, private_json, retain_private
from media_package_transaction import component, move_exclusive, sync_directory
from tdarr_media_names import path_identity


def _path(value):
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('Replacement paths must be absolute and canonical')
    canonical_root(path.parent)
    component(path.name)
    return path


def _expected(value):
    if (not isinstance(value, list) or len(value) != 8
            or any(type(field) is not int for field in value[:7])
            or not isinstance(value[7], str) or len(value[7]) != 64
            or any(char not in '0123456789abcdef' for char in value[7])):
        raise ValueError('Complete admitted file identity is required')
    return value


def _owned(assert_owner):
    if assert_owner() is not True:
        raise PermissionError('Exact replacement ownership is not confirmed')


def same_retained_generation(actual, expected, renamed):
    # An intended rename changes ctime, but never content, inode, mode or mtime.
    return (actual[:6] == expected[:6] and actual[7] == expected[7]
            and (renamed or actual[6] == expected[6]))


def replace_retaining_original(original, candidate, destination, retained, journal,
                               expected, assert_owner, checkpoint=lambda _: None):
    """Resume one immutable same-filesystem plan without overwriting any file.

    expected contains original/candidate full path_identity lists captured before
    admission/verification. Retention and journal roots must be private and outside
    both media directories. No old original is deleted, including after success.
    checkpoint is an internal crash-test hook, not an operator execution mode.
    """
    original, candidate, destination, retained, journal = paths = tuple(
        _path(value) for value in (original, candidate, destination, retained, journal))
    if (len(set(paths)) != (4 if destination == original else 5)
            or original.parent != destination.parent):
        raise ValueError('Replacement paths overlap or destination escapes its package')
    for suffix in ('.lock', '.pending', '.installed', '.installed.pending'):
        component(journal.name + suffix)
    if not isinstance(expected, dict) or set(expected) != {'original', 'candidate'}:
        raise ValueError('Exact original/candidate identities are required')
    expected = {key: _expected(value) for key, value in expected.items()}
    if expected['original'][:2] == expected['candidate'][:2]:
        raise ValueError('Original and candidate must be distinct files')
    for parent in {retained.parent, journal.parent}:
        info = parent.stat()
        if info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError('Retention state must be private and owned')
        if any(media == parent or media in parent.parents
               for media in {original.parent, candidate.parent}):
            raise ValueError('Retention state must survive media directory cleanup')
    parents = sorted({path.parent for path in paths})
    if len({path.parent.stat().st_dev for path in paths[:4]}) != 1:
        raise ValueError('Cross-filesystem replacement is not supported')
    intended = {
        'schema': 'media-original-retaining-replacement.v1',
        'paths': dict(zip(('original', 'candidate', 'destination', 'retained'),
                          map(str, paths[:4]))),
        'expected': expected,
        'roots': {str(parent): [parent.stat().st_dev, parent.stat().st_ino]
                  for parent in parents},
    }
    _owned(assert_owner)
    lock = os.open(str(journal) + '.lock',
                   os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(lock)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != os.geteuid() or info.st_mode & 0o077):
            raise ValueError('Unsafe original-retention lock')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _owned(assert_owner)
        exists = journal.exists() or journal.is_symlink()
        if exists and private_json(journal) != intended:
            raise ValueError('Replacement plan differs from its immutable journal')

        def locations():
            _owned(assert_owner)
            for parent in parents:
                canonical_root(parent)
                if [parent.stat().st_dev, parent.stat().st_ino] != intended['roots'][str(parent)]:
                    raise ValueError('Replacement directory identity changed')
            found = {}
            for path in dict.fromkeys(paths[:4]):
                if not (path.exists() or path.is_symlink()):
                    continue
                actual = list(path_identity(path))
                matches = [kind for kind, allowed, renamed in (
                    ('original', (original, retained), path == retained),
                    ('candidate', (candidate, destination), path == destination),
                ) if path in allowed and same_retained_generation(actual, expected[kind], renamed)]
                if len(matches) != 1 or matches[0] in found:
                    raise ValueError('Replacement file changed or location is ambiguous')
                found[matches[0]] = path
            if set(found) != {'original', 'candidate'}:
                raise ValueError('Replacement file is missing; automatic recovery refused')
            state = found['original'], found['candidate']
            if state not in ((original, candidate), (retained, candidate), (retained, destination)):
                raise ValueError('Replacement ordering contradicts its durable plan')
            return state

        state = locations()
        if not exists:
            if state != (original, candidate):
                raise ValueError('An unjournaled replacement cannot be adopted')
            for path in (original, candidate):
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            retain_private(journal, intended)
            checkpoint('journal')
        if locations() == (original, candidate):
            _owned(assert_owner)
            move_exclusive(original, retained)
            sync_directory(original.parent)
            sync_directory(retained.parent)
            checkpoint('original-retained')
        if locations() == (retained, candidate):
            _owned(assert_owner)
            move_exclusive(candidate, destination)
            sync_directory(candidate.parent)
            sync_directory(destination.parent)
            checkpoint('candidate-installed')
        if locations() != (retained, destination):
            raise ValueError('Replacement did not reach its retained terminal state')
        receipt = {
            'schema': intended['schema'], 'scope': 'storage-retention-only',
            'status': 'installed', 'journal': str(journal),
            'retained': str(retained), 'retainedIdentity': list(path_identity(retained)),
            'destination': str(destination), 'destinationIdentity': list(path_identity(destination)),
        }
        _owned(assert_owner)
        retain_private(journal.with_suffix(journal.suffix + '.installed'), receipt)
        checkpoint('receipt')
        return receipt
    finally:
        os.close(lock)
