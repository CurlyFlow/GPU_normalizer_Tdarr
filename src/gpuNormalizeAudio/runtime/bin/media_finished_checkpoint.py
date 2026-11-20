"""Plugin content-bound terminal continuation, never a normalization guess."""
import hashlib
import json
import stat
from pathlib import Path

from media_history_store import private_json, retain_private
from media_decision_audit import read_decision
from media_original_retention import same_retained_generation
from tdarr_media_names import path_identity


def checkpoint_prefix(authority):
    value = json.dumps([authority.library_id, str(authority.job_file.parent)])
    return hashlib.sha256(value.encode()).hexdigest()


def validate_processing_audit(authority, audit, retained_original):
    if (not isinstance(audit, dict)
            or set(audit) != {'beforeEvidence', 'audioExpectation', 'audioOutcome'}
            or not isinstance(audit['beforeEvidence'], str)
            or any(value is not None and not isinstance(value, dict)
                   for value in (audit['audioExpectation'], audit['audioOutcome']))):
        raise ValueError('Exact original processing context is required')
    before = read_decision(authority.state_root, Path(audit['beforeEvidence']), '.decision-before')
    if (before.get('reason') != 'processing' or before.get('source') != str(authority.job_file)
            or before.get('details', {}).get('originalId') != str(authority.job_file)
            or before.get('details', {}).get('libraryId') != authority.library_id
            or not isinstance(retained_original, list) or len(retained_original) != 8
            or not isinstance(before.get('fileIdentity'), list) or len(before['fileIdentity']) != 8
            or not same_retained_generation(retained_original, before.get('fileIdentity'), True)):
        raise ValueError('Processing context differs from the retained original')
    return audit


def retain_finished(authority, file, processing_audit=None, retained_original=None):
    authority.assert_owner()
    file = Path(file)
    if (file.parent != authority.job_file.parent or file.resolve(strict=True) != file
            or not stat.S_ISREG(file.lstat().st_mode)):
        raise ValueError('Finished checkpoint must identify the owned package file')
    identity = list(path_identity(file))
    record = {'source': str(file), 'identity': identity, 'library': authority.library_id}
    if processing_audit is not None or retained_original is not None:
        record['processingAudit'] = validate_processing_audit(authority, processing_audit, retained_original)
    digest = hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
    authority.assert_owner()
    retain_private(authority.state_root / (checkpoint_prefix(authority) + '.' + digest + '.finished'), record)


def checkpoint_records(authority):
    authority.assert_owner()
    paths = list(authority.state_root.glob(checkpoint_prefix(authority) + '.*.finished'))
    if len(paths) > 128:
        raise ValueError('Finished checkpoint inventory exceeds bound')
    records = []
    for path in paths:
        record = private_json(path)
        digest = hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
        if (set(record) not in ({'source', 'identity', 'library'},
                                {'source', 'identity', 'library', 'processingAudit'})
                or path.name != checkpoint_prefix(authority) + '.' + digest + '.finished'):
            raise ValueError('Finished checkpoint content identity differs')
        records.append(record)
    return records


def require_finished_audit(authority, file, installed):
    matches = [record for record in checkpoint_records(authority)
               if record['source'] == str(file) and record['library'] == authority.library_id
               and record['identity'] == installed['destinationIdentity']
               and 'processingAudit' in record]
    if len(matches) != 1:
        raise ValueError('Finished continuation lacks one original processing context')
    return validate_processing_audit(authority, matches[0]['processingAudit'], installed['retainedIdentity'])


def finished_checkpoint(authority, file):
    records = checkpoint_records(authority)
    matching = [record for record in records if record.get('source') == str(file)
                and record.get('library') == authority.library_id]
    if not matching:
        return False
    identity = list(path_identity(Path(file)))
    authority.assert_owner()
    return any(record.get('identity') == identity for record in matching)
