"""Plugin-owned naming, package commit and consumer paths; no standalone CLI."""

import copy
from pathlib import Path

from media_package_transaction import publish_package
from media_history_store import verify_committed
from tdarr_media_names import package_identity, process


def assert_evidence_current(package, evidence):
    expected = {name: tuple(value) for name, value in evidence['packageIdentity'].items()}
    if package_identity(package) != expected:
        raise ValueError('Package changed between evidence and transaction admission')


def retarget_file_objects(file_objects, target):
    updated = copy.deepcopy(file_objects)
    target = Path(target)
    for value in updated.values():
        value['_id'] = str(target)
        if 'file' in value:
            value['file'] = str(target)
        if 'meta' in value and 'Directory' in value['meta']:
            value['meta']['Directory'] = str(target.parent)
        if 'filename' in value.get('ffProbeData', {}).get('format', {}):
            value['ffProbeData']['format']['filename'] = str(target)
    return updated


def publish_finished_media(file, staging_root, completed_root, journal, file_objects,
                           authority, ffprobe='ffprobe', ffmpeg='ffmpeg', read_file=None,
                           publication_owner=None):
    """The workflow authority owns admission, evidence approval and durable plans.

    Resume uses its saved plan, never rescans an already moved source. Read-only
    scanning runs outside namespace locks; exact evidence is rechecked under
    exclusive admission before any durable plan or filesystem mutation.
    This entrypoint is not enabled by the preview CLI or the normalizer.
    """
    file = Path(file).absolute()
    staging_root = Path(staging_root).resolve(strict=True)
    completed_root = Path(completed_root).resolve(strict=True)
    if (file.parent.parent != staging_root or staging_root in completed_root.parents
            or completed_root in staging_root.parents):
        raise ValueError('Exact, non-nested operation roots are required')
    if set(file_objects) != {'inputFileObj', 'originalLibraryFile'}:
        raise ValueError('Both Tdarr file identities are required')
    if (file_objects['inputFileObj'].get('_id') != str(file)
            or Path(file_objects['originalLibraryFile'].get('_id', '')).parent != file.parent):
        raise ValueError('Tdarr file objects do not identify the finished package')

    with authority.acquire(file.parent, staging_root, completed_root) as lease:
        plan = lease.load_plan()
        companions = lease.companion_media(file, read_file) if plan is None else None
    preview = process(file, staging_root, ffprobe=ffprobe, ffmpeg=ffmpeg,
                      companions=companions) if plan is None else None

    with authority.acquire(file.parent, staging_root, completed_root) as lease:
        plan = lease.load_plan()
        if plan is None:
            if preview is None:
                raise ValueError('Durable publication plan disappeared during admission')
            assert_evidence_current(file.parent, preview)
            if lease.companion_media(file, read_file) != companions:
                raise PermissionError('Companion job evidence changed during publication')
            if lease.assert_owner() is not True:
                raise PermissionError('Active job no longer owns the package')
            destination = completed_root / Path(preview['target']).parent.name
            names = {Path(name).name: Path(name).name for name in preview['packageIdentity']
                     if Path(name) != file.parent}
            for old, new in preview['renames']:
                if Path(old).parent != file.parent or Path(new).parent != file.parent:
                    raise ValueError('Rename escapes the finished package')
                names[Path(old).name] = Path(new).name
            plan = {'source': str(file), 'destination': str(destination), 'names': names,
                    'target': str(destination / Path(preview['target']).name),
                    'journal': str(Path(journal).absolute()), 'evidence': preview}
            if publication_owner is not None:
                plan['publicationOwner'] = publication_owner
            lease.save_plan(plan)
        if (plan['source'] != str(file) or Path(plan['destination']).parent != completed_root
                or plan['journal'] != str(Path(journal).absolute())
                or Path(plan['target']).parent != Path(plan['destination'])
                or plan['names'].get(file.name) != Path(plan['target']).name):
            raise ValueError('Durable publication plan differs from this workflow')

        if not Path(plan['journal']).exists():
            assert_evidence_current(file.parent, plan['evidence'])
        def assert_package_owner():
            lease.assert_owner()
            if (file.parent.exists() and lease.companion_media(file, read_file)
                    != plan['evidence'].get('companionMedia', [])):
                raise PermissionError('Companion jobs are not settled')
            return True

        publish_package(file.parent, plan['destination'], plan['journal'], plan['names'],
                        assert_package_owner)
        # One committed path feeds every consumer; retain provenance separately.
        updated = retarget_file_objects(file_objects, plan['target'])
        result = {'fileObjects': updated, 'moveDestination': plan['target'],
                  'notifyPath': plan['target'], 'publishedStorage': plan['destination'],
                  'publishedName': Path(plan['destination']).name,
                  'originalSource': file_objects['originalLibraryFile']['_id']}
        if publication_owner is not None:
            result['publicationPlan'] = str(authority.plan_path)
        lease.commit(result)
        # Full byte verification belongs to the long-running terminal job, never
        # to a SAB API poll. Consumers see the new path only after this receipt.
        lease.assert_owner()
        if not verify_committed(Path(plan['journal']).with_suffix('.plan'), plan):
            raise ValueError('Committed media lacks independent publication proof')
        lease.assert_owner()
        return result
