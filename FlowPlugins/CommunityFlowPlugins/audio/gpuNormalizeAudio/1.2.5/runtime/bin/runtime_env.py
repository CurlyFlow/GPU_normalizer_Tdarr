from __future__ import annotations

import os


TRUE_VALUES = {'1', 'true', 'yes', 'on'}
FALSE_VALUES = {'', '0', 'false', 'no', 'off'}


def env_flag(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in TRUE_VALUES:
        return True
    if normalized in FALSE_VALUES:
        return False
    return default


def env_int(name, default, *, minimum=1):
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return max(minimum, parsed)


def env_nonnegative_int(name, default):
    return env_int(name, default, minimum=0)


def env_bytes_mib(name, default_mib, *, minimum=1):
    value = os.environ.get(name)
    default_bytes = int(default_mib * 1024 * 1024)
    if value is None:
        return default_bytes
    try:
        parsed = int(float(value) * 1024 * 1024)
    except ValueError:
        return default_bytes
    return max(minimum, parsed)
