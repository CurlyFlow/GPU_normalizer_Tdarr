#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import subprocess
import sys


MANIFEST_NAME = 'release-manifest.json'
MANIFEST_SCHEMA = 'gpuNormalizeAudio.releaseSnapshot.v1'
PLUGIN_NAME = 'gpuNormalizeAudio'
SOURCE_PATH = 'src/gpuNormalizeAudio'
GENERATED_BY = './work/tdarr stage-release-version'


def fail(message: str) -> None:
    print(f'ERR: {message}', file=sys.stderr)
    raise SystemExit(1)


def _snapshot_metadata(version: str, snapshot_path: str, generated_by: str) -> dict[str, str]:
    return {
        'schema': MANIFEST_SCHEMA,
        'plugin': PLUGIN_NAME,
        'version': version,
        'sourcePath': SOURCE_PATH,
        'snapshotPath': snapshot_path,
        'generatedBy': generated_by,
    }


def _is_ignored_snapshot_file(name: str) -> bool:
    return name == MANIFEST_NAME or name == '.DS_Store' or name.endswith(('.pyc', '.pyo'))


def _iter_snapshot_files(root: str):
    for dirpath, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d != '__pycache__')
        for name in sorted(names):
            if _is_ignored_snapshot_file(name):
                continue
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root).replace(os.sep, '/')
            yield rel, path


def _file_entry(root: str, rel: str, path: str) -> dict[str, str]:
    with open(path, 'rb') as handle:
        digest = hashlib.sha256(handle.read()).hexdigest()
    return {
        'path': rel,
        'sha256': digest,
        'mode': format(stat.S_IMODE(os.stat(path).st_mode), '04o'),
    }


def write_manifest(version: str, snapshot_path: str, root: str, *, generated_by: str = GENERATED_BY) -> None:
    files = [_file_entry(root, rel, path) for rel, path in _iter_snapshot_files(root)]
    files.sort(key=lambda entry: entry['path'])
    manifest = {
        **_snapshot_metadata(version, snapshot_path, generated_by),
        'files': files,
    }
    with open(os.path.join(root, MANIFEST_NAME), 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write('\n')


def _validate_file_entry(index: int, entry: object, root: str, seen: dict[str, bool]) -> str:
    if not isinstance(entry, dict):
        fail(f'release manifest file entry {index} is not an object')
    rel = entry.get('path')
    digest = entry.get('sha256')
    mode = entry.get('mode')
    if not isinstance(rel, str) or not rel or rel.startswith('/') or rel.split('/') != [part for part in rel.split('/') if part not in ('', '.', '..')]:
        fail(f'invalid release manifest file path: {rel!r}')
    if rel == MANIFEST_NAME:
        fail('release manifest must not hash itself')
    if rel in seen:
        fail(f'duplicate release manifest file path: {rel}')
    if not isinstance(digest, str) or len(digest) != 64 or any(ch not in '0123456789abcdef' for ch in digest):
        fail(f'invalid sha256 for {rel}')
    if not isinstance(mode, str) or len(mode) != 4 or any(ch not in '01234567' for ch in mode):
        fail(f'invalid mode for {rel}')
    path = os.path.join(root, rel)
    if not os.path.isfile(path):
        fail(f'release manifest file missing: {rel}')
    with open(path, 'rb') as handle:
        actual_digest = hashlib.sha256(handle.read()).hexdigest()
    if actual_digest != digest:
        fail(f'release manifest hash mismatch for {rel}')
    actual_mode = format(stat.S_IMODE(os.stat(path).st_mode), '04o')
    if actual_mode != mode:
        fail(f'release manifest mode mismatch for {rel}: got {actual_mode}, expected {mode}')
    seen[rel] = True
    return rel


def _tracked_snapshot_files(root: str) -> list[str]:
    tracked_files = subprocess.check_output(['git', 'ls-files', '--', root], text=True).splitlines()
    rels = []
    for tracked_file in tracked_files:
        rel = os.path.relpath(tracked_file, root).replace(os.sep, '/')
        if rel != MANIFEST_NAME:
            rels.append(rel)
    return rels


def _archive_snapshot_files(root: str) -> list[str]:
    return [rel for rel, _ in _iter_snapshot_files(root)]


def validate_manifest(manifest_path: str, version: str, root: str, expected_root: str, tracked: str,
                      *, generated_by: str = GENERATED_BY) -> None:
    try:
        with open(manifest_path, 'r', encoding='utf-8') as handle:
            manifest = json.load(handle)
    except Exception as exc:
        fail(f'invalid release manifest {manifest_path}: {exc}')

    for key, value in _snapshot_metadata(version, expected_root, generated_by).items():
        if manifest.get(key) != value:
            fail(f'release manifest {key} mismatch: got {manifest.get(key)!r}, expected {value!r}')

    entries = manifest.get('files')
    if not isinstance(entries, list) or not entries:
        fail('release manifest files must be a non-empty list')

    seen: dict[str, bool] = {}
    for index, entry in enumerate(entries):
        _validate_file_entry(index, entry, root, seen)

    snapshot_rels = _tracked_snapshot_files(root) if tracked == '1' else _archive_snapshot_files(root)

    missing_from_manifest = sorted(set(snapshot_rels) - set(seen))
    if missing_from_manifest:
        fail('tracked release files missing from manifest: ' + ', '.join(missing_from_manifest[:10]))

    extra_manifest_files = sorted(set(seen) - set(snapshot_rels))
    if extra_manifest_files:
        fail('manifest files are not tracked in release snapshot: ' + ', '.join(extra_manifest_files[:10]))


def main_validate(argv: list[str] | None = None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 5:
        fail('usage: validate-release-manifest <manifest> <version> <root> <expected-root> <tracked:0|1>')
    validate_manifest(*argv)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description='Write or validate gpuNormalizeAudio release manifests.')
    subparsers = parser.add_subparsers(dest='command', required=True)

    write_parser = subparsers.add_parser('write')
    write_parser.add_argument('version')
    write_parser.add_argument('snapshot_path')
    write_parser.add_argument('root')

    validate_parser = subparsers.add_parser('validate')
    validate_parser.add_argument('manifest_path')
    validate_parser.add_argument('version')
    validate_parser.add_argument('root')
    validate_parser.add_argument('expected_root')
    validate_parser.add_argument('tracked')

    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == 'write':
        write_manifest(args.version, args.snapshot_path, args.root)
    else:
        validate_manifest(args.manifest_path, args.version, args.root, args.expected_root, args.tracked)


if __name__ == '__main__':
    main()
