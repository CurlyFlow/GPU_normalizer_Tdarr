"""Durable original/expected/published evidence, distinct from import success."""
from pathlib import Path

from media_decision_audit import (decision_evidence, retain_decision, retain_decision_result,
                                 assert_decision_source, read_decision)
from media_flow_authority import FlowAuthority
from media_history_store import private_json, committed_publication_for_file, finished_media_digest


def processing_audit(request, read_staged, *, min_file_size_bytes=0):
    required = {'fileObjects', 'stagingRoot', 'completedRoot', 'stateRoot', 'decisionAudit'}
    if not isinstance(request, dict) or set(request) != required:
        raise ValueError('Exact processing audit request is required')
    action = request['decisionAudit']
    if not isinstance(action, dict) or action.get('stage') not in {'admission', 'beforeReplace', 'published', 'rejected'}:
        raise ValueError('Unknown processing audit stage')
    objects = request['fileObjects']
    root = Path(request['stateRoot'])
    current = objects['inputFileObj']
    if action['stage'] == 'admission':
        if set(action) != {'stage', 'expected'} or not isinstance(action['expected'], dict):
            raise ValueError('Expected processing outcome is required')
        original = objects['originalLibraryFile']
        source = Path(original['_id'])
        authority = FlowAuthority(str(source), original['DB'], root, read_staged,
                                  min_file_size_bytes=min_file_size_bytes, allow_sibling_jobs=True)
        with authority.acquire(source.parent, request['stagingRoot'], request['completedRoot']):
            authority.assert_owner()
        evidence = decision_evidence(source, 'processing',
            {'status': 'provided-by-tdarr' if original.get('ffProbeData') else 'unavailable',
             'metadata': original.get('ffProbeData')},
            action['expected'], {'originalId': str(source), 'libraryId': original['DB']})
        with authority.acquire(source.parent, request['stagingRoot'], request['completedRoot']):
            assert_decision_source(evidence)
            before = retain_decision(root, evidence)
        return {'audited': True, 'beforeEvidence': str(before)}
    required_action = {'stage', 'beforeEvidence', 'audioExpectation', 'audioOutcome'}
    expected_action = required_action | {'rejectionAfter'} if action['stage'] == 'rejected' else required_action
    allowed_actions = (expected_action, expected_action | {'publicationPlan'}) if action['stage'] == 'published' else (expected_action,)
    if set(action) not in allowed_actions:
        raise ValueError('Exact processing audit continuation is required')
    before = Path(action['beforeEvidence'])
    evidence = read_decision(root, before, '.decision-before')
    if evidence.get('reason') != 'processing':
        raise ValueError('Not an original processing audit')
    original_id = evidence['details']['originalId']
    authority = FlowAuthority(original_id, evidence['details']['libraryId'], root, read_staged,
                              min_file_size_bytes=min_file_size_bytes, allow_sibling_jobs=True)
    with authority.acquire(Path(original_id).parent, request['stagingRoot'], request['completedRoot']):
        if action['stage'] == 'beforeReplace':
            assert_decision_source(evidence)
            return {'audited': True, 'beforeEvidence': str(before)}
        if action['stage'] == 'rejected':
            rejected_path = Path(action['rejectionAfter'])
            rejected = read_decision(root, rejected_path, '.decision-after')
            outcome = rejected.get('mediaAfterActual', {})
            full_package_ack = (outcome.get('nativeStatus') == 'Failed'
                                and outcome.get('sourceAbsent') is True
                                and outcome.get('packageAbsent') is True)
            sibling_episode_ack = (outcome.get('nativeStatus') == 'SiblingDeferred'
                                   and outcome.get('sourceAbsent') is True
                                   and outcome.get('packageAbsent') is False)
            if (rejected.get('source') != evidence['source']
                    or rejected.get('fileIdentity', [])[-1:] != evidence['fileIdentity'][-1:]
                    or not (full_package_ack or sibling_episode_ack)):
                raise ValueError('Processing rejection is not an acknowledged cleanup of this input')
            after = retain_decision_result(root, evidence, before,
                {'status': 'rejected-after-native-ack' if full_package_ack else 'rejected-sibling-episode',
                 'rejectionEvidence': str(rejected_path),
                 'nativeStatus': outcome.get('nativeStatus'), 'sourceAbsent': True,
                 'packageAbsent': outcome.get('packageAbsent'),
                 'audioExpectation': action['audioExpectation'], 'audioOutcome': action['audioOutcome']})
            return {'audited': True, 'beforeEvidence': str(before), 'afterEvidence': str(after)}
        path, plan, publication = committed_publication_for_file(root, current['_id'], action.get('publicationPlan'))
        if Path(publication['originalSource']).parent != Path(original_id).parent:
            raise ValueError('Published outcome belongs to another original package')
        proof = private_json(path.with_suffix('.history-verified'))
        output = publication['notifyPath']
        metadata = proof.get('metadata', {}).get(output)
        digest = finished_media_digest(plan)
        if not isinstance(metadata, list) or len(metadata) != 7 or digest is None:
            raise ValueError('Published output lacks retained identity and content proof')
        actual = {'status': 'published-and-byte-verified', 'output': output,
            'fileIdentity': [*metadata, digest], 'mediaInfo': publication['fileObjects']['inputFileObj'].get('ffProbeData'),
            'publicationReceipt': str(path.with_suffix('.result')), 'currentOutputPresent': Path(output).exists(),
            'audioExpectation': action['audioExpectation'], 'audioOutcome': action['audioOutcome'],
            'ordinaryImportVerified': False}
        after = retain_decision_result(root, evidence, before, actual)
        return {'audited': True, 'beforeEvidence': str(before), 'afterEvidence': str(after)}
