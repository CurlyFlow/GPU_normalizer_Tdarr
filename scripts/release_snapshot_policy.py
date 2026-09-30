#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fnmatch
import os
import re
import sys


ALLOWED_SOURCE_PATTERNS = (
    'index.js',
    'lib/*.js',
    'runtime/bin/loudnorm-gpu-source-port',
    'runtime/bin/*.py',
    'runtime/bin/*.c',
    'runtime/bin/*.so',
    'runtime/cuda/*.py',
    'runtime/cuda/*.cu',
    'runtime/cuda/*.cuh',
    'runtime/cuda/*.ptx',
)

IGNORED_NAMES = {'.DS_Store'}
IGNORED_SUFFIXES = ('.pyc', '.pyo')
IGNORED_DIRS = {'__pycache__'}

PRIVATE_TERM_PATTERNS = (
    re.compile(r'/home/agent'),
    re.compile(r'/mnt/tdarr(?:-dev)?'),
    re.compile(r'\btdarr-dev\b', re.IGNORECASE),
    re.compile(r'\bunraid\b', re.IGNORECASE),
    re.compile(r'\b(?:root|agent)@[A-Za-z0-9_.-]+'),
    re.compile(r'\b192\.168\.\d{1,3}\.\d{1,3}\b'),
    re.compile(r'(?i)\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|secret)\b\s*[:=]'),
)


def fail(message: str) -> None:
    print(f'ERR: {message}', file=sys.stderr)
    raise SystemExit(1)


def _norm_rel(path: str) -> str:
    return path.replace(os.sep, '/')


def _is_ignored(path: str, name: str) -> bool:
    parts = set(_norm_rel(path).split('/'))
    return bool(parts & IGNORED_DIRS or name in IGNORED_NAMES or name.endswith(IGNORED_SUFFIXES))


def _is_allowed_source_rel(rel: str) -> bool:
    return any(fnmatch.fnmatchcase(rel, pattern) for pattern in ALLOWED_SOURCE_PATTERNS)


def source_files(source_root: str) -> list[str]:
    files: list[str] = []
    for dirpath, dirs, names in os.walk(source_root):
        dirs[:] = sorted(d for d in dirs if d not in IGNORED_DIRS)
        for name in sorted(names):
            path = os.path.join(dirpath, name)
            if _is_ignored(path, name):
                continue
            rel = _norm_rel(os.path.relpath(path, source_root))
            if not _is_allowed_source_rel(rel):
                fail(f'source file is outside release managed-file policy: {rel}')
            files.append(rel)
    return sorted(files)


def list_source(source_root: str, source_prefix: str) -> None:
    for rel in source_files(source_root):
        print(f'{source_prefix.rstrip("/")}/{rel}')


def _scan_text(rel: str, data: bytes) -> list[str]:
    # Native artifacts can contain embedded build paths or credentials too.
    text = data.decode('utf-8', errors='replace')
    findings = []
    for pattern in PRIVATE_TERM_PATTERNS:
        match = pattern.search(text)
        if match:
            findings.append(f'{rel}: matched {pattern.pattern!r} near {match.group(0)!r}')
    return findings


def scan_snapshot(root: str) -> None:
    findings: list[str] = []
    for dirpath, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in IGNORED_DIRS)
        for name in sorted(names):
            path = os.path.join(dirpath, name)
            if _is_ignored(path, name):
                continue
            rel = _norm_rel(os.path.relpath(path, root))
            for pattern in PRIVATE_TERM_PATTERNS:
                if pattern.search(rel):
                    findings.append(f'{rel}: path matched {pattern.pattern!r}')
            with open(path, 'rb') as handle:
                findings.extend(_scan_text(rel, handle.read()))
    if findings:
        fail('private-term scan failed:\n' + '\n'.join(findings[:20]))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description='Validate gpuNormalizeAudio release snapshot file policy.')
    subparsers = parser.add_subparsers(dest='command', required=True)

    list_parser = subparsers.add_parser('list-source')
    list_parser.add_argument('source_root')
    list_parser.add_argument('source_prefix')

    scan_parser = subparsers.add_parser('scan')
    scan_parser.add_argument('root')

    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == 'list-source':
        list_source(args.source_root, args.source_prefix)
    else:
        scan_snapshot(args.root)


if __name__ == '__main__':
    main()
