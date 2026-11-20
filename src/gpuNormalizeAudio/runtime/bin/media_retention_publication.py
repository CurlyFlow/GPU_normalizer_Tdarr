"""Bind an installed retained generation through the existing package journal."""

from pathlib import Path

from media_history_store import private_json
from media_original_retention import same_retained_generation
from tdarr_media_names import path_identity


def verify_retention_history(authority, paths, admitted, receipt):
    journal = private_json(paths['journal'])
    copied = private_json(paths['copyRecord'])
    expected_paths = {'original': str(authority.job_file), 'candidate': str(paths['copy']),
                      'destination': str(paths['destination']), 'retained': str(paths['original'])}
    expected = admitted['expected']
    retained = list(path_identity(paths['original']))
    if (journal.get('schema') != 'media-original-retaining-replacement.v1'
            or journal.get('paths') != expected_paths
            or copied.get('source') != admitted['scope']['candidate']
            or copied.get('target') != str(paths['copy']) or copied.get('expected') != expected['candidate']
            or journal.get('expected') != {'original': expected['original'], 'candidate': copied.get('identity')}
            or receipt.get('schema') != journal['schema'] or receipt.get('scope') != 'storage-retention-only'
            or receipt.get('status') != 'installed' or receipt.get('journal') != str(paths['journal'])
            or receipt.get('retained') != str(paths['original'])
            or receipt.get('destination') != str(paths['destination'])
            or receipt.get('retainedIdentity') != retained
            or not same_retained_generation(retained, expected['original'], True)
            or not same_retained_generation(receipt['destinationIdentity'], copied['identity'], True)):
        raise ValueError('Installed retention history differs from admission')


def verify_publication_generation(authority, scope, paths, receipt, plan):
    if (plan.get('source') != str(paths['destination'])
            or plan.get('journal') != str(authority.journal_path)
            or Path(plan.get('destination', '')).parent != Path(scope['completedRoot'])
            or plan.get('evidence', {}).get('finishedIdentity') != receipt['destinationIdentity']):
        raise ValueError('Publication plan is not the admitted installed generation')
    old = paths['destination'].name
    new = plan.get('names', {}).get(old)
    if not isinstance(new, str) or Path(new).name != new or new in ('', '.', '..'):
        raise ValueError('Publication does not map the installed finished file')
    packages = (paths['destination'].parent, Path(plan['destination']),
                Path(scope['completedRoot']) / ('.publication-' + Path(plan['journal']).name))
    found = []
    for package in packages:
        for name in dict.fromkeys((old, new)):
            file = package / name
            if file.exists() or file.is_symlink():
                if file.resolve(strict=True) != file:
                    raise ValueError('Published generation is not canonical')
                actual = list(path_identity(file))
                if not same_retained_generation(actual, receipt['destinationIdentity'], True):
                    raise ValueError('Published file differs from admitted installed media')
                found.append(file)
    if len(found) != 1:
        raise ValueError('Published retained generation is missing or ambiguous')
    authority.assert_owner()
