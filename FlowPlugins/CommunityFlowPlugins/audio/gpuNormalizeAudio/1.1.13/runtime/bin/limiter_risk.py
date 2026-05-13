from __future__ import annotations

import struct


def build_prelimiter_risk_map(peak_bits_host, gains_host, gains_next_host, windows, ceiling, expand_windows, expand_after_windows=None):
    expand_before_windows = expand_windows
    if expand_after_windows is None:
        expand_after_windows = expand_windows
    prelimiter_unsafe_flags = [0] * windows
    unsafe_windows = 0
    max_pre_peak = 0.0
    first_unsafe = -1
    last_unsafe = -1
    for w in range(windows):
        raw_peak = struct.unpack('f', struct.pack('I', int(peak_bits_host[w])))[0] if peak_bits_host[w] else 0.0
        g = max(float(gains_host[w]), float(gains_next_host[w]))
        pre_peak = abs(raw_peak) * max(0.0, g)
        if pre_peak > max_pre_peak:
            max_pre_peak = pre_peak
        if pre_peak > ceiling:
            unsafe_windows += 1
            if first_unsafe < 0:
                first_unsafe = w
            last_unsafe = w
            lo = max(0, w - expand_before_windows)
            hi = min(windows, w + expand_after_windows + 1)
            for mark_w in range(lo, hi):
                prelimiter_unsafe_flags[mark_w] = 1
    unsafe_fraction = (unsafe_windows / float(windows)) if windows else 0.0
    flagged_windows = sum(prelimiter_unsafe_flags)
    flagged_islands = 0
    longest_flagged_run = 0
    longest_safe_run = 0
    current_flagged_run = 0
    current_safe_run = 0
    previous_flag = 0
    for flag in prelimiter_unsafe_flags:
        if flag:
            if not previous_flag:
                flagged_islands += 1
            current_flagged_run += 1
            if current_flagged_run > longest_flagged_run:
                longest_flagged_run = current_flagged_run
            current_safe_run = 0
        else:
            current_safe_run += 1
            if current_safe_run > longest_safe_run:
                longest_safe_run = current_safe_run
            current_flagged_run = 0
        previous_flag = flag
    flagged_fraction = (flagged_windows / float(windows)) if windows else 0.0
    return prelimiter_unsafe_flags, {
        'unsafe_windows': unsafe_windows,
        'unsafe_fraction': unsafe_fraction,
        'risk_expand_before_windows': expand_before_windows,
        'risk_expand_after_windows': expand_after_windows,
        'flagged_windows': flagged_windows,
        'flagged_fraction': flagged_fraction,
        'flagged_islands': flagged_islands,
        'longest_flagged_run': longest_flagged_run,
        'longest_safe_run': longest_safe_run,
        'first_unsafe': first_unsafe,
        'last_unsafe': last_unsafe,
        'max_pre_peak': max_pre_peak,
    }
