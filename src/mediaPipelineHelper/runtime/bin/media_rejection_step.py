"""Active plugin rejection: acknowledge native failure before removing a package."""
from pathlib import Path
from itertools import islice
import time

from media_download_rejection import failure_message, rejection_lease, request_key, source_identity
from media_flow_authority import FlowAuthority, MEDIA_SUFFIXES
from media_history_store import private_json, retain_private
from media_package_transaction import identity, sync_directory
from media_decision_audit import (decision_evidence, retain_decision, assert_decision_source,
                                 retain_decision_result, read_decision)
from tdarr_media_names import SIDECAR


def package_inventory(package, source, companions=()):
    if package.resolve(strict=True) != package or not package.is_dir():
        raise ValueError('Rejected package is not canonical')
    entries = sorted(package.iterdir())
    if not entries or len(entries) > 128:
        raise ValueError('Rejected package inventory exceeds its bound')
    expected = {source, *map(Path, companions)}
    if (any(entry.parent != package for entry in expected)
            or {entry for entry in entries if entry.suffix.lower() in MEDIA_SUFFIXES} != expected):
        raise ValueError('Rejection media differs from the exactly proved package ownership')
    return {entry.name: identity(entry) for entry in entries}


def retained_rejection_plan(authority, source, rejection):
    # Read the former job-only filename for persisted, interrupted handoffs.
    legacy = authority.plan_path.with_suffix('.rejection-plan')
    paths = list(islice(legacy.parent.glob(legacy.stem + '.*.rejection-plan'), 129))
    if legacy.exists():
        paths.append(legacy)
    if len(paths) > 128:
        raise ValueError('Retained rejection attempt inventory exceeds its bound')
    pending = []
    for path in paths:
        plan = private_json(path)
        outgoing = plan['request']
        receipt = path.parent / (request_key(outgoing) + '.rejection-result')
        acknowledged = receipt.exists() or receipt.with_suffix('.rejection-original').exists()
        if not acknowledged or (receipt.with_suffix('.rejection-cleaned').exists() and source.exists()):
            continue
        if (outgoing['source'] != str(source) or outgoing['reason'] != rejection['reason']
                or outgoing['selectedLanguages'] != rejection['selectedLanguages']):
            raise ValueError('Retained rejection plan belongs to another input decision')
        pending.append(plan)
    if len(pending) > 1:
        raise ValueError('Multiple acknowledged rejection attempts require reconciliation')
    return pending[0] if pending else None


def rejection_plan(authority, source, rejection, media_before=None):
    retained = retained_rejection_plan(authority, source, rejection)
    if retained is not None:
        return retained
    outgoing = {'source': str(source), 'sourceIdentity': source_identity(source),
                'reason': rejection['reason'], 'selectedLanguages': rejection['selectedLanguages']}
    path = authority.plan_path.with_suffix('.' + request_key(outgoing) + '.rejection-plan')
    if path.exists():
        plan = private_json(path)
        if plan['request'] != outgoing:
            raise ValueError('Retained rejection attempt differs from its source identity')
        return plan
    inventory = package_inventory(source.parent, source)
    info = source.parent.stat()
    diagnostic = rejection.get('evidence', {})
    audit = decision_evidence(source, rejection['reason'],
        diagnostic.get('mediaBefore', {'status': 'probed' if media_before else 'unavailable', 'metadata': media_before}),
        {'sourceAbsent': True, 'packageAbsent': True, 'nativeStatus': 'Failed',
         'tdarrRemoval': 'after-acknowledged-cleanup', 'normalized': False}, diagnostic)
    if (rejection['reason'] == 'unreadableMedia'
            and diagnostic.get('ffmpegRead', {}).get('fileIdentity') != list(map(str, audit['fileIdentity'][:-1]))):
        raise ValueError('Unreadable-media evidence no longer identifies this input epoch')
    audit_path = retain_decision(authority.plan_path.parent, audit)
    plan = {'request': outgoing,
            'inventory': inventory, 'packageIdentity': [str(info.st_dev), str(info.st_ino)],
            'audit': audit, 'auditPath': str(audit_path)}
    authority.assert_owner()
    retain_private(path, plan)
    return plan


def cleanup_package(authority, package, plan):
    """Resume only the exact remaining entries; Arr may already have removed them."""
    def assert_package():
        if package.resolve(strict=True) != package:
            raise ValueError('Rejected package is no longer canonical')
        info = package.stat()
        if [str(info.st_dev), str(info.st_ino)] != plan['packageIdentity']:
            raise ValueError('Rejected package was replaced')

    try:
        assert_package()
        remaining = {entry.name: identity(entry) for entry in package.iterdir()}
    except FileNotFoundError:
        # A disappearing child alone is not proof that the package disappeared.
        if not package.exists():
            return
        raise
    if any(plan['inventory'].get(name) != value for name, value in remaining.items()):
        raise ValueError('Rejected package changed before cleanup')
    for name, expected_identity in remaining.items():
        authority.assert_owner()
        try:
            assert_package()
            entry = package / name
            if identity(entry) != expected_identity:
                raise ValueError('Rejected package entry changed before cleanup')
            if entry.is_dir():
                entry.rmdir()
            else:
                entry.unlink()
        except FileNotFoundError:
            continue
    try:
        assert_package()
        package.rmdir()
    except FileNotFoundError:
        pass
    sync_directory(package.parent)


def _reject_sibling_episode(authority, source, rejection, media_before, state, prepare_only):
    diagnostic = rejection.get('evidence', {})
    audit = decision_evidence(source, rejection['reason'],
        diagnostic.get('mediaBefore', {'status': 'probed' if media_before else 'unavailable', 'metadata': media_before}),
        {'sourceAbsent': True, 'packageAbsent': False, 'nativeStatus': 'SiblingDeferred',
         'tdarrRemoval': 'requested-on-flow-completion', 'normalized': False}, diagnostic)
    if (rejection['reason'] == 'unreadableMedia'
            and diagnostic.get('ffmpegRead', {}).get('fileIdentity') != list(map(str, audit['fileIdentity'][:-1]))):
        raise ValueError('Unreadable-media evidence no longer identifies this input epoch')
    before = diagnostic.get('processingBefore')
    if before is not None:
        admitted = read_decision(state, before, '.decision-before')
        if (admitted.get('reason') != 'processing' or admitted.get('source') != str(source)
                or admitted.get('details', {}).get('originalId') != str(source)
                or admitted.get('details', {}).get('libraryId') != authority.library_id
                or admitted.get('fileIdentity') != audit.get('fileIdentity')):
            raise ValueError('Rejected input differs from the admitted original')
        if source.exists():
            assert_decision_source(admitted)
    audit_path = retain_decision(state, audit)
    if prepare_only:
        return {'rejectionPrepared': True, 'auditPath': str(audit_path), 'siblingDeferred': True}
    if source.exists():
        assert_decision_source(audit)
    authority.assert_owner()
    parent = source.parent
    stem_prefix = source.stem + '.'
    for entry in sorted(parent.iterdir()):
        if entry == source or (entry.name.startswith(stem_prefix) and entry.suffix.lower() in SIDECAR):
            try:
                identity(entry)
                if not entry.is_dir():
                    entry.unlink()
            except FileNotFoundError:
                continue
    sync_directory(parent)
    authority.mark_sibling_rejected(source)
    after = retain_decision_result(state, audit, audit_path,
        {'sourceAbsent': not source.exists(), 'packageAbsent': not parent.exists(),
         'nativeStatus': 'SiblingDeferred', 'tdarrRemoval': 'requested-on-flow-completion',
         'normalized': False})
    return {'rejected': True, 'removedEpisode': True, 'removedPackage': False,
            'nativeStatus': 'SiblingDeferred', 'auditBefore': str(audit_path), 'auditAfter': str(after)}


def reject_download(request, read_staged, *, wait=time.sleep, now=time.monotonic, prepare_only=False,
                    min_file_size_bytes=0, remove_file=None):
    expected = {'fileObjects', 'rejection', 'stagingRoot', 'completedRoot', 'stateRoot'}
    if not isinstance(request, dict) or set(request) != expected:
        raise ValueError('Exact active plugin rejection request is required')
    objects = request['fileObjects']
    original, current = objects['originalLibraryFile'], objects['inputFileObj']
    rejection = request['rejection']
    fields = {'reason', 'inputFileId', 'selectedLanguages'}
    if (set(rejection) not in (fields, fields | {'evidence'})
            or rejection['inputFileId'] != current['_id']):
        raise ValueError('Rejection does not identify the current plugin input')
    source = Path(original['_id'])
    staging, completed, state = (Path(request[key]) for key in ('stagingRoot', 'completedRoot', 'stateRoot'))
    if source.parent.parent != staging or '..' in source.parts:
        raise ValueError('Rejected source is outside the staging package scope')
    authority = FlowAuthority(str(source), original['DB'], state, read_staged,
                              min_file_size_bytes=min_file_size_bytes, allow_sibling_jobs=True)
    with authority.acquire(source.parent, staging, completed):
        if (completed / source.parent.name).exists():
            raise ValueError('A published package must never be rejected')
        authority.prune_below_min_companions(source, remove_file=remove_file)
        if authority.sibling_media(source):
            return _reject_sibling_episode(authority, source, rejection, current.get('ffProbeData'), state, prepare_only)
        authority.assert_owner(package_exclusive=True)
        plan = rejection_plan(authority, source, rejection, current.get('ffProbeData'))
        before = rejection.get('evidence', {}).get('processingBefore')
        if before is not None:
            admitted = read_decision(state, before, '.decision-before')
            if (admitted.get('reason') != 'processing' or admitted.get('source') != str(source)
                    or admitted.get('details', {}).get('originalId') != str(source)
                    or admitted.get('details', {}).get('libraryId') != original['DB']
                    or admitted.get('fileIdentity') != plan.get('audit', {}).get('fileIdentity')):
                raise ValueError('Rejected input differs from the admitted original')
            if source.exists():
                assert_decision_source(admitted)
        if prepare_only:
            return {'rejectionPrepared': True, 'auditPath': plan.get('auditPath')}
        if plan.get('audit') and source.exists():
            assert_decision_source(plan['audit'])
        outgoing = plan['request']
        message = failure_message(outgoing)
        path = state / (request_key(outgoing) + '.rejection-request')
        with rejection_lease(path):
            return finish_rejection(authority, path, plan, message, source, wait, now)


def finish_rejection(authority, path, plan, message, source, wait, now, *, before_cleanup=lambda: None):
    outgoing = plan['request']
    authority.assert_owner()
    retain_private(path, outgoing)
    receipt = path.with_suffix('.rejection-result')
    deadline = now() + 180
    while not receipt.exists():
        authority.assert_owner()
        if path.with_suffix('.rejection-error').exists():
            raise ValueError('Native downloader refused the plugin rejection request')
        if now() >= deadline:
            raise TimeoutError('Native downloader did not acknowledge plugin rejection')
        wait(1)
    result = private_json(receipt)
    if (result.get('request') != outgoing or result.get('status') != 'Failed'
            or result.get('fail_message') != message):
        raise ValueError('Native downloader rejection was not acknowledged')
    authority.assert_owner()
    # Arr can consume the same Failed row and remove the rejected download.
    # Never remove a replacement or another package after that handoff.
    if plan.get('audit') and source.exists():
        assert_decision_source(plan['audit'])
    before_cleanup()
    cleanup_package(authority, source.parent, plan)
    after = None
    if plan.get('audit'):
        after = retain_decision_result(path.parent, plan['audit'], plan['auditPath'],
            {'sourceAbsent': not source.exists(), 'packageAbsent': not source.parent.exists(),
             'nativeStatus': result['status'], 'acknowledgement': str(receipt),
              'tdarrRemoval': 'requested-on-flow-completion',
              **({'normalizationPerformedByRejection': False} if outgoing.get('publication') else {'normalized': False})})
    retain_private(path.with_suffix('.rejection-cleaned'), result)
    return {'rejected': True, 'removedPackage': True, 'nativeStatus': 'Failed',
            **({'auditBefore': plan['auditPath'], 'auditAfter': str(after)} if after else {})}
