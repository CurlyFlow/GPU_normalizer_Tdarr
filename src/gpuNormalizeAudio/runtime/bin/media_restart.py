"""Discard an owned unfinished attempt and put the admitted original back."""

import os
from pathlib import Path
import stat

from media_history_store import private_json
from media_original_retention import same_retained_generation
from media_package_transaction import move_exclusive, sync_directory
from tdarr_media_names import path_identity


def restart_from_original(authority, paths, admitted):
    authority.assert_owner()
    original, retained = authority.job_file, paths['original']
    expected = admitted['expected']['original']
    destination = paths['destination']
    root = paths['acceptance'].parent
    names = {'acceptance.json', 'acceptance.json.pending', 'incoming', 'original', 'transaction'}
    allowed = {'incoming': {'candidate.mp4', 'candidate.mp4.pending'}, 'original': {original.name},
               'transaction': {'copy.json', 'copy.json.pending', 'replacement.json', 'replacement.json.pending',
                               'replacement.json.lock', 'replacement.json.installed', 'replacement.json.installed.pending'}}
    # Inspect the complete small owned namespace before deleting anything.
    files = []
    entries = list(root.iterdir())
    if len(entries) > len(names) or any(entry.name not in names for entry in entries):
        raise ValueError('Unknown restart state must not be removed')
    for entry in entries:
        members = [entry]
        if entry.name in allowed:
            if entry.resolve(strict=True) != entry or not entry.is_dir():
                raise ValueError('Unsafe restart directory')
            members = list(entry.iterdir())
            if len(members) > len(allowed[entry.name]) or any(item.name not in allowed[entry.name] for item in members):
                raise ValueError('Unknown restart artifacts must not be removed')
        for file in members:
            info = file.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or (file != retained and (info.st_uid != os.geteuid() or info.st_mode & 0o077))
                    or file.resolve(strict=True) != file):
                raise ValueError('Unsafe restart artifact')
            files.append(file)
    is_original = lambda file: file.exists() and same_retained_generation(list(path_identity(file)), expected, True)
    if not is_original(original) and not is_original(retained):
        raise ValueError('An intact admitted original is required for restart')
    if original.exists() and retained.exists() and is_original(original):
        raise ValueError('Original location is ambiguous; automatic cleanup refused')
    candidate = Path(admitted['scope']['candidate'])
    if candidate.exists() and list(path_identity(candidate)) != admitted['expected']['candidate']:
        raise ValueError('Changed candidate is not owned restart work')
    if destination.exists() and not (destination == original and is_original(original)):
        journal = private_json(paths['journal'])
        if not same_retained_generation(list(path_identity(destination)), journal['expected']['candidate'], True):
            raise ValueError('Foreign destination must not be deleted on restart')
        authority.assert_owner()
        destination.unlink()
        sync_directory(destination.parent)
    if retained.exists():
        authority.assert_owner()
        move_exclusive(retained, original)
        sync_directory(original.parent)
        sync_directory(retained.parent)
    if not is_original(original):
        raise ValueError('Original restoration was not established')
    authority.assert_owner()
    if candidate.exists():
        candidate.unlink()
        sync_directory(candidate.parent)
    for file in files:
        if file not in (retained, paths['acceptance']):
            file.unlink()
    for name in allowed:
        if (root / name).exists():
            (root / name).rmdir()
    paths['acceptance'].unlink()
    root.rmdir()
    sync_directory(root.parent)


def discard_unadmitted_state(authority, root):
    """Discard only a known unsealed acceptance and empty private scaffolding."""
    authority.assert_owner()
    if root.resolve(strict=True) != root:
        raise ValueError('Unadmitted restart state is not canonical')
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError('Unadmitted restart state is not private')
    original = path_identity(authority.job_file)
    if not stat.S_ISREG(original[2]) or original[3] != 1 or original[-1] is None:
        raise ValueError('An intact original is required before discarding unsealed work')
    entries = list(root.iterdir())
    for entry in entries:
        item = entry.lstat()
        if entry.resolve(strict=True) != entry or item.st_uid != os.geteuid() or item.st_mode & 0o077:
            raise ValueError('Unsafe unadmitted restart artifact')
        if entry.name == 'acceptance.json.pending':
            if not stat.S_ISREG(item.st_mode) or item.st_nlink != 1:
                raise ValueError('Unsafe pending acceptance')
        elif entry.name not in ('incoming', 'original', 'transaction') or not stat.S_ISDIR(item.st_mode) or any(entry.iterdir()):
            raise ValueError('Unadmitted nonempty state requires explicit recovery')
    authority.assert_owner()
    if path_identity(authority.job_file) != original:
        raise ValueError('Original changed before unsealed cleanup')
    for entry in entries:
        if entry.name == 'acceptance.json.pending':
            entry.unlink()
        else:
            entry.rmdir()
    root.rmdir()
    sync_directory(root.parent)
