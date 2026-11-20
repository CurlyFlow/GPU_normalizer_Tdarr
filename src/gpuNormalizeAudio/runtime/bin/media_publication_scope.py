"""One physical download package owns one publication generation, not its path forever."""
import hashlib
import json
import stat
from itertools import islice
from pathlib import Path

from media_history_store import private_json


def publication_scope(library, package, state, legacy_plan, completed_root):
    package, state, completed_root = Path(package), Path(state), Path(completed_root)
    schema = 'media-publication-generation.v1'

    def declared(plan):
        owner = plan.get('publicationOwner')
        return (isinstance(owner, dict) and set(owner) == {'schema', 'library', 'package', 'directory'}
                and owner['schema'] == schema and owner['library'] == library
                and owner['package'] == str(package)
                and isinstance(owner['directory'], list) and len(owner['directory']) == 2
                and all(type(value) is int and value >= 0 for value in owner['directory']))

    if package.exists() or package.is_symlink():
        info = package.lstat()
        if package.resolve(strict=True) != package or not stat.S_ISDIR(info.st_mode):
            raise ValueError('Publication package is not a canonical directory')
        identity = [info.st_dev, info.st_ino]
        # A concrete unfinished old-format transaction remains resumable only
        # for the same physical package. Completed old attempts are never reused.
        if legacy_plan.exists() and not legacy_plan.with_suffix('.result').exists():
            old = private_json(legacy_plan)
            evidence = old.get('evidence', {}).get('packageIdentity', {}).get(str(package), [])
            if Path(old.get('source', '')).parent == package and evidence[:2] == identity:
                return legacy_plan, None
        owner = {'schema': schema, 'library': library, 'package': str(package), 'directory': identity}
        digest = hashlib.sha256(json.dumps(owner, sort_keys=True).encode()).hexdigest()
        selected = state / (digest + '.plan')
        if selected.exists():
            previous = private_json(selected)
            if previous.get('publicationOwner') != owner or selected.with_suffix('.result').exists():
                raise ValueError('Completed or conflicting publication generation cannot own a fresh source')
        return selected, owner

    # A crash after the namespace move can leave only the hidden/final location.
    # Resolve its exact journal identity; never choose a newest timestamp.
    paths = list(islice(state.glob('*.plan'), 1001))
    if len(paths) > 1000:
        raise ValueError('Publication generation inventory exceeds bound')
    candidates = []
    for path in paths:
        plan = private_json(path)
        if Path(plan.get('source', '')).parent != package or not (declared(plan) or path == legacy_plan):
            continue
        destination, journal = Path(plan['destination']), Path(plan['journal'])
        if destination.parent != completed_root or journal != path.with_suffix('.journal') or not journal.exists():
            continue
        record = private_json(journal)
        locations = [candidate for candidate in (completed_root / ('.publication-' + journal.name), destination)
                     if candidate.exists() or candidate.is_symlink()]
        if len(locations) == 1:
            info = locations[0].lstat()
            if stat.S_ISDIR(info.st_mode) and [info.st_dev, info.st_ino] == record.get('directory'):
                candidates.append((path, plan.get('publicationOwner')))
    if len(candidates) != 1:
        raise ValueError('Require one exact physical publication generation for continuation')
    return candidates[0]
