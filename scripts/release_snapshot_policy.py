#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fnmatch
import os
import re
import subprocess
import sys


ALLOWED_SOURCE_PATTERNS = (
    'index.js',
    'lib/*.js',
    'runtime/bin/loudnorm-gpu-source-port',
    'runtime/bin/audio_clock_mux',
    'runtime/bin/*.py',
    'runtime/bin/*.c',
    'runtime/bin/*.h',
    'runtime/bin/*.so',
    'runtime/cuda/*.py',
    'runtime/cuda/*.cu',
    'runtime/cuda/*.cuh',
    'runtime/cuda/*.ptx',
)

IGNORED_NAMES = {'.DS_Store'}
IGNORED_SUFFIXES = ('.pyc', '.pyo')
IGNORED_DIRS = {'__pycache__'}

FORBIDDEN_GIT_PREFIXES = (
    'docs/',
    'work/',
    '.agents/',
    'tools/',
    'results/',
    'bench/results/',
)

FORBIDDEN_GIT_FILES = {
    'AGENTS.md',
    '.ignore',
    '.env',
}

FORBIDDEN_GIT_SUFFIXES = (
    '.nzb',
    '.mkv',
    '.mp4',
    '.m4a',
    '.mov',
    '.wav',
    '.f32',
    '.db',
    '.sqlite',
    '.sqlite3',
    '.credentials.json',
)

# Generic, public-safe patterns that never hardcode local hostnames or usernames.
PRIVATE_TERM_PATTERNS = (
    re.compile(r'(?:/home|/Users)/[A-Za-z0-9_.-]+/'),
    re.compile(r'C:\\Users\\[A-Za-z0-9_.-]+\\'),
    re.compile(r'/mnt/(?:user|cache|disk\d+|tdarr[^/\s]*)/?'),
    re.compile(r'\broot@[A-Za-z0-9_.-]+'),
    re.compile(r'\b192\.168\.\d{1,3}\.\d{1,3}\b'),
    re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----'),
    re.compile(r'(?i)\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|secret)\b\s*[:=]'),
    re.compile(r'\b[A-Za-z0-9]+(?:\.[A-Za-z0-9]+){1,}\.(?:19\d\d|20\d\d|S\d{2}E\d{2})\.[A-Za-z0-9._-]+'),
    re.compile(r'(?i)\b[A-Za-z0-9]+(?:\.[A-Za-z0-9]+){1,}\.(?:2160p|1080p|720p)\.[A-Za-z0-9._-]+-[A-Za-z0-9]{2,}\b'),
    re.compile(r'(?i)\.nzb\b'),
)

SELF_TEST_FILES = {
    'scripts/release_snapshot_policy.py',
    'scripts/quality-contracts.test.js',
    'package-lock.json',
}


def _repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_extra_patterns() -> list[tuple[str, re.Pattern[str]]]:
    """Load optional private literal terms from an untracked local .env file."""
    env_path = os.environ.get('PRIVACY_ENV_FILE') or os.path.join(_repo_root(), '.env')
    raw_terms: list[str] = []
    if os.environ.get('PRIVACY_EXTRA_TERMS'):
        raw_terms.append(os.environ['PRIVACY_EXTRA_TERMS'])
    if os.path.isfile(env_path):
        try:
            with open(env_path, 'r', encoding='utf-8', errors='replace') as handle:
                for line in handle:
                    stripped = line.strip()
                    if not stripped or stripped.startswith('#') or '=' not in stripped:
                        continue
                    key, value = stripped.split('=', 1)
                    if key.strip() == 'PRIVACY_EXTRA_TERMS':
                        raw_terms.append(value.strip().strip('"').strip("'"))
        except OSError:
            pass
    patterns: list[tuple[str, re.Pattern[str]]] = []
    seen: set[str] = set()
    for chunk in raw_terms:
        for item in re.split(r'[,;\n]+', chunk):
            term = item.strip()
            if not term or term.lower() in seen:
                continue
            seen.add(term.lower())
            if re.fullmatch(r'[A-Za-z0-9_]+', term):
                pat = re.compile(rf'\b{re.escape(term)}\b', re.IGNORECASE)
            else:
                pat = re.compile(re.escape(term), re.IGNORECASE)
            patterns.append(('local-env-term', pat))
    return patterns


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


def _scan_text(rel: str, data: bytes, extra_patterns: list[tuple[str, re.Pattern[str]]] | None = None) -> list[str]:
    # Native artifacts can contain embedded build paths or credentials too.
    text = data.decode('utf-8', errors='replace')
    findings = []
    for pattern in PRIVATE_TERM_PATTERNS:
        match = pattern.search(text)
        if match:
            findings.append(f'{rel}: matched {pattern.pattern!r} near {match.group(0)!r}')
    for label, pattern in (extra_patterns or ()):
        match = pattern.search(text)
        if match:
            findings.append(f'{rel}: matched {label} (redacted)')
    return findings


def _check_forbidden_git_path(rel: str) -> str | None:
    norm = _norm_rel(rel).lstrip('./')
    if norm in FORBIDDEN_GIT_FILES or norm.startswith('.env.'):
        return f'{norm}: forbidden private file'
    if any(norm.startswith(prefix) for prefix in FORBIDDEN_GIT_PREFIXES):
        return f'{norm}: forbidden private directory'
    if norm.lower().endswith(FORBIDDEN_GIT_SUFFIXES):
        return f'{norm}: forbidden media/secret/database artifact'
    return None


def scan_snapshot(root: str) -> None:
    extra_patterns = _load_extra_patterns()
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
            for label, pattern in extra_patterns:
                if pattern.search(rel):
                    findings.append(f'{rel}: path matched {label} (redacted)')
            with open(path, 'rb') as handle:
                findings.extend(_scan_text(rel, handle.read(), extra_patterns))
    if findings:
        fail('private-term scan failed:\n' + '\n'.join(findings[:20]))


def _git_file_list(repo: str, staged: bool) -> list[str]:
    if staged:
        cmd = ['git', '-C', repo, 'diff', '--cached', '--name-only', '--diff-filter=ACMR']
    else:
        cmd = ['git', '-C', repo, 'ls-files']
    out = subprocess.check_output(cmd, text=True)
    return [line.strip() for line in out.splitlines() if line.strip()]


def _read_git_blob(repo: str, rel: str, staged: bool) -> bytes:
    if staged:
        return subprocess.check_output(['git', '-C', repo, 'show', f':{rel}'])
    with open(os.path.join(repo, rel), 'rb') as handle:
        return handle.read()


def scan_git(staged: bool = False, commit_msg_file: str | None = None) -> None:
    repo = _repo_root()
    extra_patterns = _load_extra_patterns()
    findings: list[str] = []

    if commit_msg_file is not None:
        with open(commit_msg_file, 'rb') as handle:
            findings.extend(_scan_text('commit-message', handle.read(), extra_patterns))
        if findings:
            fail('private-term commit-message scan failed:\n' + '\n'.join(findings[:20]))
        return

    for rel in _git_file_list(repo, staged=staged):
        forbidden = _check_forbidden_git_path(rel)
        if forbidden:
            findings.append(forbidden)
            continue
        if rel in SELF_TEST_FILES:
            continue
        for pattern in PRIVATE_TERM_PATTERNS:
            if pattern.search(rel):
                findings.append(f'{rel}: path matched {pattern.pattern!r}')
        for label, pattern in extra_patterns:
            if pattern.search(rel):
                findings.append(f'{rel}: path matched {label} (redacted)')
        try:
            data = _read_git_blob(repo, rel, staged=staged)
        except (OSError, subprocess.CalledProcessError):
            continue
        findings.extend(_scan_text(rel, data, extra_patterns))
    if findings:
        fail('private-term git scan failed:\n' + '\n'.join(findings[:20]))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description='Validate gpuNormalizeAudio release snapshot file policy.')
    subparsers = parser.add_subparsers(dest='command', required=True)

    list_parser = subparsers.add_parser('list-source')
    list_parser.add_argument('source_root')
    list_parser.add_argument('source_prefix')

    scan_parser = subparsers.add_parser('scan')
    scan_parser.add_argument('root')

    git_parser = subparsers.add_parser('scan-git')
    group = git_parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--staged', action='store_true')
    group.add_argument('--tracked', action='store_true')
    group.add_argument('--commit-msg', dest='commit_msg')

    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == 'list-source':
        list_source(args.source_root, args.source_prefix)
    elif args.command == 'scan':
        scan_snapshot(args.root)
    else:
        scan_git(staged=args.staged, commit_msg_file=args.commit_msg)


if __name__ == '__main__':
    main()
