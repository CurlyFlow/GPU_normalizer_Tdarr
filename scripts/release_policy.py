#!/usr/bin/env python3
from __future__ import annotations

import re
import sys


_VALID_VERSION_RE = re.compile(r'^[A-Za-z0-9._-]+$')
_WIP_VERSION_RE = re.compile(r'wip|dev|tmp|snapshot', re.IGNORECASE)


def fail(message: str, code: int = 1) -> None:
    print(f'ERR: {message}', file=sys.stderr)
    raise SystemExit(code)


def is_valid_version(version: str) -> bool:
    return bool(version and _VALID_VERSION_RE.fullmatch(version))


def is_wip_snapshot_name(version: str) -> bool:
    return bool(_WIP_VERSION_RE.search(version or ''))


def assert_valid_version(version: str) -> None:
    if not is_valid_version(version):
        fail(f'invalid version: {version}')


def assert_release_version(version: str) -> None:
    assert_valid_version(version)
    if is_wip_snapshot_name(version):
        fail(f'refusing release snapshot WIP/dev version: {version}')


def main(argv: list[str] | None = None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 2 or argv[0] not in {'assert-valid', 'assert-release', 'is-wip'}:
        fail('usage: release_policy.py <assert-valid|assert-release|is-wip> <version>', code=2)
    command, version = argv
    if command == 'assert-valid':
        assert_valid_version(version)
        return
    if command == 'assert-release':
        assert_release_version(version)
        return
    assert_valid_version(version)
    raise SystemExit(0 if is_wip_snapshot_name(version) else 1)


if __name__ == '__main__':
    main()
