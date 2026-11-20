"""Private immutable decision evidence; expected outcomes never imply completion."""
from datetime import datetime, timezone
from pathlib import Path
import stat

from media_history_store import publication_record_digest, retain_private, private_json
from tdarr_media_names import path_identity, path_metadata


def content_identity(source, verified_digest=None):
    source = Path(source)
    if source.resolve(strict=True) != source or not source.is_file():
        raise ValueError('Decision source is not canonical media')
    fingerprint = (list(path_identity(source)) if verified_digest is None
                   else [*path_metadata(source), verified_digest])
    if (fingerprint[3] != 1 or not stat.S_ISREG(fingerprint[2])
            or not isinstance(fingerprint[-1], str) or len(fingerprint[-1]) != 64
            or any(char not in '0123456789abcdef' for char in fingerprint[-1])):
        raise ValueError('Decision requires a single-link content fingerprint')
    return fingerprint


def decision_evidence(source, reason, media_before, expected, details, verified_digest=None):
    fingerprint = content_identity(source, verified_digest)
    return {'schema': 'media-decision.v1', 'capturedAt': datetime.now(timezone.utc).isoformat(),
            'source': str(source), 'fileIdentity': fingerprint, 'hashAlgorithm': 'sha256',
            'hashSource': 'verified-publication' if verified_digest else 'current-full-content-read',
            'mediaBefore': media_before, 'mediaAfterExpected': expected,
            'mediaAfterActual': None, 'reason': reason, 'details': details}


def retain_decision(root, evidence):
    path = Path(root) / (publication_record_digest(evidence) + '.decision-before')
    retain_private(path, evidence)
    return path


def read_decision(root, path, suffix):
    path = Path(path)
    if (suffix not in {'.decision-before', '.decision-after'} or path.parent != Path(root)
            or path.suffix != suffix or len(path.stem) != 64
            or any(char not in '0123456789abcdef' for char in path.stem)):
        raise ValueError('Decision evidence escapes its private namespace')
    evidence = private_json(path)
    if (not isinstance(evidence, dict) or evidence.get('schema') != 'media-decision.v1'
            or publication_record_digest(evidence) != path.stem):
        raise ValueError('Decision evidence content identity changed')
    return evidence


def assert_decision_source(evidence):
    source = Path(evidence['source'])
    if source.resolve(strict=True) != source or list(path_metadata(source)) != evidence['fileIdentity'][:-1]:
        raise ValueError('Decision input changed after its content/media evidence')


def retain_decision_result(root, evidence, before_path, actual):
    if read_decision(root, before_path, '.decision-before') != evidence or not isinstance(actual, dict):
        raise ValueError('Actual outcome must retain the original decision evidence')
    result = {**evidence, 'beforeEvidence': str(before_path), 'mediaAfterActual': actual,
              'completedAt': datetime.now(timezone.utc).isoformat()}
    path = Path(root) / (publication_record_digest(result) + '.decision-after')
    retain_private(path, result)
    return path
