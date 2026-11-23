"""Reject one proved inferior publication; never touch the existing library file."""
import json
from pathlib import Path
import sys
import time

from media_decision_audit import decision_evidence, retain_decision, retain_decision_result, assert_decision_source
from media_download_rejection import failure_message, rejection_lease, request_key, source_identity
from media_history_store import (committed_publication_for_file, finished_media_digest, private_json,
                                 publication_record_digest, retain_private)
from media_package_transaction import package_namespace
from media_quality_decision import proved_quality_decision, quality_snapshot, assert_library_unchanged, non_upgrade_rows
from media_rejection_step import package_inventory, finish_rejection


class CompletedAuthority:
    def __init__(self, path, base, publication, registration, read_staged, active_job):
        self.path, self.base, self.publication, self.registration = path, base, publication, registration
        self.read_staged, self.active_job = read_staged, active_job
        self.reference = {'plan': str(path), 'planDigest': publication_record_digest(base),
            'resultDigest': publication_record_digest(publication), 'registrationDigest': publication_record_digest(registration)}

    def assert_owner(self):
        if Path(self.base['source']).parent.exists():
            raise ValueError('Original staging package exists; completed cleanup is not authoritative')
        for suffix, key in [('.plan', 'planDigest'), ('.result', 'resultDigest'),
                            ('.history-registration', 'registrationDigest')]:
            if publication_record_digest(private_json(self.path.with_suffix(suffix))) != self.reference[key]:
                raise ValueError('Publication evidence changed')
        stages = self.read_staged()
        if not isinstance(stages, list) or len(stages) > 128:
            raise ValueError('Complete native job ownership is unavailable')
        packages = {Path(self.base['source']).parent, Path(self.base['target']).parent}
        matching = [stage for stage in stages if any(Path(stage.get(key, {}).get('_id') or '').parent in packages
                    for key in ('originalLibraryFile', 'inputFileObj'))]
        if self.active_job is None:
            if matching:
                raise ValueError('A native job still owns the completed package')
        else:
            expected = self.active_job
            if (len(matching) != 1 or matching[0].get('status') != 'processing'
                    or matching[0].get('originalLibraryFile', {}).get('_id') != expected['source']
                    or matching[0].get('originalLibraryFile', {}).get('DB') != expected['libraryId']):
                raise ValueError('Active helper does not exclusively own this publication')
        return True


def publication_library(publication, active_job):
    objects = publication['fileObjects']
    library = objects['originalLibraryFile'].get('DB')
    if not isinstance(library, str) or not library or len(library) > 128 or '\x00' in library:
        raise ValueError('Publication requires its original native library identity')
    working_library = objects['inputFileObj'].get('DB')
    if working_library is not None and working_library != library:
        raise ValueError('Working file library differs from original native library')
    if active_job is not None and active_job['libraryId'] != library:
        raise ValueError('Active job library differs from original native library')
    return library


def reject_completed(request, read_staged, read_arr, read_file, remove_file,
                     *, wait=time.sleep, now=time.monotonic):
    required = {'application', 'file', 'stagingRoot', 'completedRoot', 'stateRoot', 'activeJob', 'ffprobe'}
    if not isinstance(request, dict) or set(request) not in (required, required | {'publicationPlan'}):
        raise ValueError('Require one exact configured completed rejection')
    source = Path(request['file'])
    staging, completed, state = (Path(request[key]) for key in ('stagingRoot', 'completedRoot', 'stateRoot'))
    if source.parent.parent != completed or '..' in source.parts:
        raise ValueError('Completed rejection is outside its configured package root')
    if any(state == root or root in state.parents for root in (staging, completed)):
        raise ValueError('Private rejection evidence must be outside both media roots')
    active = request['activeJob']
    if active is not None and (not isinstance(active, dict) or set(active) != {'source', 'libraryId'}
            or not all(isinstance(value, str) and value for value in active.values())):
        raise ValueError('Active rejection requires an exact native job identity')
    path, base, publication = committed_publication_for_file(state, source, request.get('publicationPlan'))
    if Path(base['source']).parent.parent != staging:
        raise ValueError('Publication staging provenance differs')
    library = publication_library(publication, active)
    registration = private_json(path.with_suffix('.history-registration'))
    authority = CompletedAuthority(path, base, publication, registration, read_staged, request['activeJob'])
    retained_path = path.with_suffix('.quality-rejection-plan')
    with package_namespace(staging, completed):
        authority.assert_owner()
        completed_path = path.with_suffix('.quality-rejection-complete')
        if completed_path.exists():
            done = private_json(completed_path)
            if (done.get('publication') != authority.reference or source.parent.exists()
                    or any(read_file(file) for file in done['fileIds'])):
                raise ValueError('Completed cleanup cannot be replayed against replacement data')
            return done['result']
        if retained_path.exists():
            plan = private_json(retained_path)
            if plan['request']['publication'] != authority.reference:
                raise ValueError('Retained cleanup belongs to another publication')
        else:
            decision = proved_quality_decision(request['application'], source, base, publication,
                                               registration, read_arr, request['ffprobe'])
            audit = decision_evidence(source, 'notQualityUpgrade',
                {'status': 'published-and-probed', 'technicalFacts': decision['actualMedia'],
                 'metadata': publication['fileObjects']['inputFileObj'].get('ffProbeData'),
                 'metadataSource': 'byte-verified-publication'},
                {'nativeStatus': 'Failed', 'sourceAbsent': True, 'packageAbsent': True,
                 'existingLibraryFile': 'unchanged', 'tdarrFilesAbsent': True},
                {'publication': authority.reference, 'arrDecision': decision['arr']},
                verified_digest=finished_media_digest(base))
            audit_path = retain_decision(state, audit)
            info = source.parent.stat()
            outgoing = {'source': str(source), 'sourceIdentity': source_identity(source),
                        'reason': 'notQualityUpgrade', 'selectedLanguages': [], 'publication': authority.reference}
            companions = [source.parent / Path(value).name for value in base['evidence'].get('companionMedia', [])]
            plan = {'request': outgoing, 'inventory': package_inventory(source.parent, source, companions),
                    'packageIdentity': [str(info.st_dev), str(info.st_ino)],
                    'audit': audit, 'auditPath': str(audit_path), 'arrDecision': decision['arr']}
            authority.assert_owner()
            retain_private(retained_path, plan)
        receipt_path = state / (request_key(plan['request']) + '.rejection-request')
        acknowledged = receipt_path.with_suffix('.rejection-result').exists()
        if source.exists():
            assert_decision_source(plan['audit'])
        if not acknowledged:
            current = quality_snapshot(request['application'], source, publication, registration, read_arr)
            if current != plan['arrDecision']:
                raise ValueError('Current non-upgrade decision changed after durable intent')
        with rejection_lease(receipt_path):
            result = finish_rejection(authority, receipt_path, plan, failure_message(plan['request']), source,
                wait, now, before_cleanup=lambda: assert_library_unchanged(plan['arrDecision'], read_arr))
        # Only already-absent files from this exact publication/library may lose
        # FileDB rows. Staged job removal remains the active helper's completion.
        files = {publication['originalSource'], str(source)}
        if request['activeJob'] is not None:
            files.add(request['activeJob']['source'])
        authority.assert_owner()
        for file in sorted(files):
            record = read_file(file)
            if record is not None:
                if record.get('_id') != file or record.get('DB') != library or Path(file).exists():
                    raise ValueError('FileDB cleanup identity differs from the rejected publication')
                remove_file(file)
            if read_file(file):
                raise ValueError('FileDB cleanup is not proven')
        assert_library_unchanged(plan['arrDecision'], read_arr)
        after = retain_decision_result(state, plan['audit'], plan['auditPath'],
            {'nativeStatus': 'Failed', 'acknowledgement': str(receipt_path.with_suffix('.rejection-result')),
             'sourceAbsent': not source.exists(), 'packageAbsent': not source.parent.exists(),
             'tdarrFilesAbsent': True, 'existingLibraryFile': 'unchanged',
             'activeStageRemoval': 'on-helper-completion' if request['activeJob'] else 'no-stage-present'})
        result = {**result, 'qualityRejected': True, 'auditBefore': plan['auditPath'], 'auditAfter': str(after)}
        retain_private(completed_path, {'publication': authority.reference, 'fileIds': sorted(files), 'result': result})
        return result


def try_completed_rejection(request, read_staged, read_arr, read_file, remove_file):
    source = Path(request['file'])
    path, _, publication = committed_publication_for_file(request['stateRoot'], source, request.get('publicationPlan'))
    if path.with_suffix('.quality-rejection-plan').exists():
        return reject_completed(request, read_staged, read_arr, read_file, remove_file)
    if not source.exists():
        return {'qualityRejected': False, 'status': 'published-source-absent'}
    registration_path = path.with_suffix('.history-registration')
    if not registration_path.exists():
        return {'qualityRejected': False, 'status': 'native-attempt-not-registered'}
    if not non_upgrade_rows(source, publication, private_json(registration_path), read_arr('queue?page=1&pageSize=1000')):
        return {'qualityRejected': False, 'status': 'no-supported-non-upgrade-decision'}
    return reject_completed(request, read_staged, read_arr, read_file, remove_file)


def main():
    try:
        if len(sys.argv) != 1:
            raise ValueError('Completed rejection accepts private stdin only')
        payload = sys.stdin.buffer.read(32769)
        if len(payload) > 32768:
            raise ValueError('Completed rejection request exceeds bound')
        request = json.loads(payload)
        from arr_import_recovery import arr_get
        from tdarr_api import configured_reader, configured_file_remover
        config = request.pop('tdarr')
        read = configured_reader(config)
        inputs = {'arr': request['application'], 'arr_host': request.pop('host'), 'arr_api_key': request.pop('apiKey')}
        print(json.dumps(reject_completed(request, lambda: read('StagedJSONDB', 'getAll', ''),
            lambda endpoint: arr_get(inputs, endpoint), lambda file: read('FileJSONDB', 'getById', file),
            configured_file_remover(config))))
    except Exception as error:
        print(json.dumps({'error': type(error).__name__, 'qualityRejected': False}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
