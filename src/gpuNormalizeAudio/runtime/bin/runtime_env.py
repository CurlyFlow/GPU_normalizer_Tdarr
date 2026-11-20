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


def env_present(name):
    return bool(os.environ.get(name))


def env_present_not_false(name):
    value = os.environ.get(name)
    if value is None:
        return False
    return value.strip().lower() not in FALSE_VALUES


def env_string(name, default='', *, strip=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip() if strip else value


def env_int(name, default, *, minimum=1, invalid_default=None):
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError:
        parsed = default if invalid_default is None else invalid_default
    if minimum is None:
        return parsed
    return max(minimum, parsed)


def env_int_unbounded(name, default):
    return env_int(name, default, minimum=None)


def env_nonnegative_int(name, default):
    return env_int(name, default, minimum=0)


def env_float(name, default, *, minimum=None, invalid_default=None):
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        parsed = float(value)
    except ValueError:
        parsed = default if invalid_default is None else invalid_default
    if minimum is None:
        return parsed
    return max(minimum, parsed)


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


def env_optional_bytes_mib(name, *, minimum=1):
    value = os.environ.get(name)
    if not value:
        return None
    try:
        parsed = int(float(value) * 1024 * 1024)
    except ValueError:
        return None
    return max(minimum, parsed)
