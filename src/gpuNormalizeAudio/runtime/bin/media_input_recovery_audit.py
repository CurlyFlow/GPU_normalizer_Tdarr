"""Record a read-only stream-copy repair before normal processing resumes."""
from pathlib import Path

from media_decision_audit import (decision_evidence, retain_decision, assert_decision_source,
                                 retain_decision_result, content_identity)
from media_flow_authority import FlowAuthority
from tdarr_media_names import path_metadata


def record_input_recovery(request, read_staged):
    if not isinstance(request, dict) or set(request) != {'fileObjects', 'stagingRoot', 'completedRoot', 'stateRoot', 'inputRecovery', 'workRoot'}:
        raise ValueError('Exact input repair audit request required')
    original = request['fileObjects']['originalLibraryFile']
    current = request['fileObjects']['inputFileObj']
    source, repaired = Path(original['_id']), Path(current['_id'])
    root = Path(request['workRoot'])
    if (root.resolve(strict=True) != root or repaired.resolve(strict=True) != repaired
            or repaired.parent.parent != root or repaired == source):
        raise ValueError('Repair evidence must identify the owned working copy')
    if not isinstance(current.get('ffProbeData'), dict) or not current['ffProbeData'].get('streams'):
        raise ValueError('Repaired working media requires actual stream metadata')
    authority = FlowAuthority(str(source), original['DB'], Path(request['stateRoot']), read_staged)
    with authority.acquire(source.parent, request['stagingRoot'], request['completedRoot']):
        authority.assert_owner()
    recovery = request['inputRecovery']
    before = decision_evidence(source, 'inputStreamCopyRepair', recovery['mediaBefore'],
        {'action': 'stream-copy-working-file', 'reencoded': False,
         'originalUnchanged': True, 'normalization': 'not-yet-started'}, recovery['repair'])
    repaired_identity = content_identity(repaired)
    with authority.acquire(source.parent, request['stagingRoot'], request['completedRoot']):
        assert_decision_source(before)
        if list(path_metadata(repaired)) != repaired_identity[:-1]:
            raise ValueError('Repaired working file changed during audit')
        authority.assert_owner()
        before_path = retain_decision(request['stateRoot'], before)
        after_path = retain_decision_result(request['stateRoot'], before, before_path,
            {'workingFile': str(repaired), 'fileIdentity': repaired_identity,
             'media': current['ffProbeData'], 'originalUnchanged': True, 'normalized': False})
    return {'audited': True, 'beforeEvidence': str(before_path), 'afterEvidence': str(after_path)}
