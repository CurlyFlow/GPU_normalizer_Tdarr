from __future__ import annotations

import array
import math


def db_to_amp(db):
    return 10.0 ** (db / 20.0)


def amp_to_db(amp):
    return 20.0 * math.log10(max(float(amp), 1e-12))


def frame_size(rate, frame_len_msec):
    size = round(float(rate) * (float(frame_len_msec) / 1000.0))
    return int(size) + (int(size) % 2)


def gaussian_weights():
    sigma = 3.5
    out = []
    for x in range(-10, 11):
        out.append(math.exp(-((x * x) / (2.0 * sigma * sigma))))
    total = sum(out)
    return [x / total for x in out]


def ebur128_filter_coeffs(rate):
    f0 = 1681.974450955533
    g = 3.999843853973347
    q = 0.7071752369554196
    k = math.tan(math.pi * f0 / float(rate))
    vh = 10.0 ** (g / 20.0)
    vb = vh ** 0.4996667741545416
    pb = [0.0, 0.0, 0.0]
    pa = [1.0, 0.0, 0.0]
    rb = [1.0, -2.0, 1.0]
    ra = [1.0, 0.0, 0.0]
    a0 = 1.0 + k / q + k * k
    pb[0] = (vh + vb * k / q + k * k) / a0
    pb[1] = 2.0 * (k * k - vh) / a0
    pb[2] = (vh - vb * k / q + k * k) / a0
    pa[1] = 2.0 * (k * k - 1.0) / a0
    pa[2] = (1.0 - k / q + k * k) / a0
    f0 = 38.13547087602444
    q = 0.5003270373238773
    k = math.tan(math.pi * f0 / float(rate))
    ra[1] = 2.0 * (k * k - 1.0) / (1.0 + k / q + k * k)
    ra[2] = (1.0 - k / q + k * k) / (1.0 + k / q + k * k)
    b = [0.0] * 5
    a = [0.0] * 5
    b[0] = pb[0] * rb[0]
    b[1] = pb[0] * rb[1] + pb[1] * rb[0]
    b[2] = pb[0] * rb[2] + pb[1] * rb[1] + pb[2] * rb[0]
    b[3] = pb[1] * rb[2] + pb[2] * rb[1]
    b[4] = pb[2] * rb[2]
    a[0] = pa[0] * ra[0]
    a[1] = pa[0] * ra[1] + pa[1] * ra[0]
    a[2] = pa[0] * ra[2] + pa[1] * ra[1] + pa[2] * ra[0]
    a[3] = pa[1] * ra[2] + pa[2] * ra[1]
    a[4] = pa[2] * ra[2]
    return b, a


def ebur128_transition_matrix(frames, a):
    p = [0.0] * 16
    for i in range(4):
        p[i * 4 + i] = 1.0
    for _ in range(frames):
        r0 = [
            -a[1] * p[0] - a[2] * p[4] - a[3] * p[8] - a[4] * p[12],
            -a[1] * p[1] - a[2] * p[5] - a[3] * p[9] - a[4] * p[13],
            -a[1] * p[2] - a[2] * p[6] - a[3] * p[10] - a[4] * p[14],
            -a[1] * p[3] - a[2] * p[7] - a[3] * p[11] - a[4] * p[15],
        ]
        p = r0 + p[0:4] + p[4:8] + p[8:12]
    return p


def histogram_tables():
    energies = [10.0 ** (((i / 10.0) - 69.95 + 0.691) / 10.0) for i in range(1000)]
    boundaries = [10.0 ** ((-70.0 + 0.691) / 10.0)]
    boundaries.extend(10.0 ** (((i / 10.0) - 70.0 + 0.691) / 10.0) for i in range(1, 1001))
    return energies, boundaries


def energy_to_loudness(energy):
    if energy <= 0.0:
        return -float('inf')
    return 10.0 * math.log10(energy) - 0.691


def histogram_index(energy, boundaries):
    lo = 0
    hi = 1000
    while hi - lo != 1:
        mid = (lo + hi) // 2
        if energy >= boundaries[mid]:
            lo = mid
        else:
            hi = mid
    return lo


def gated_loudness(hist, energies, boundaries):
    count = sum(hist)
    if count <= 0:
        return -float('inf')
    avg = sum(c * e for c, e in zip(hist, energies)) / count
    rel = avg * (10.0 ** (-10.0 / 10.0))
    if rel < boundaries[0]:
        start = 0
    else:
        start = histogram_index(rel, boundaries)
        if rel > energies[start]:
            start += 1
    gated_count = sum(hist[start:])
    if gated_count <= 0:
        return -float('inf')
    gated = sum(hist[i] * energies[i] for i in range(start, 1000)) / gated_count
    return energy_to_loudness(gated)


def input_loudness_from_window_sums(window_sums, frames_per_window):
    energies, boundaries = histogram_tables()
    hist = [0] * 1000
    for t in range(3, len(window_sums)):
        energy = sum(window_sums[t - 3:t + 1]) / float(frames_per_window * 4)
        if energy >= boundaries[0]:
            hist[histogram_index(energy, boundaries)] += 1
    return gated_loudness(hist, energies, boundaries)


def relative_threshold(hist, energies, boundaries):
    count = sum(hist)
    if count <= 0:
        return -70.0
    avg = sum(c * e for c, e in zip(hist, energies)) / count
    return energy_to_loudness(avg * (10.0 ** (-10.0 / 10.0)))


def gaussian_filter_delta(delta, weights, index):
    # Same ring indexing as FFmpeg loudnorm: start 10 frames behind unless wrapping.
    index = index - 10 if index - 10 > 0 else index + 20
    total = 0.0
    for i, w in enumerate(weights):
        total += delta[(index + i) if (index + i) < 30 else (index + i - 30)] * w
    return total


def build_source_port_gains(window_sums, window_peaks, frames_per_window, target_i, target_lra):
    """Port the CPU source-core dynamic envelope over 100 ms windows.

    The heavy per-sample/window sums are computed on CUDA. This function mirrors
    the CPU source state machine (`delta[30]`, gaussian filter, relative gate,
    LRA clamp, above_threshold) over the small 100 ms window arrays.
    """
    windows = len(window_sums)
    if windows == 0:
        return array.array('f')
    weights = gaussian_weights()
    energies, boundaries = histogram_tables()
    hist = [0] * 1000
    short_sum = 0.0
    short_ring = [0.0] * 30
    short_index = 0
    short_count = 0
    delta = [1.0] * 30
    prev_delta = 1.0
    index = 1
    above_threshold = 0
    measured_i = 0.0
    measured_thresh = -70.0
    gains = [1.0] * windows

    def push_short(value):
        nonlocal short_sum, short_index, short_count
        if short_count == 30:
            short_sum -= short_ring[short_index]
        else:
            short_count += 1
        short_ring[short_index] = value
        short_sum += value
        short_index = (short_index + 1) % 30

    def add_hist_block(end_idx):
        if end_idx < 3:
            return
        energy = sum(window_sums[end_idx - 3:end_idx + 1]) / float(frames_per_window * 4)
        if energy >= boundaries[0]:
            hist[histogram_index(energy, boundaries)] += 1

    # Feed first 3 seconds before the first output, matching source FIRST_FRAME.
    first_end = min(windows, 30) - 1
    for t in range(first_end + 1):
        push_short(window_sums[t])
        add_hist_block(t)

    if short_count:
        shortterm = energy_to_loudness(short_sum / float(frames_per_window * 30))
    else:
        shortterm = -float('inf')
    if shortterm < measured_thresh:
        above_threshold = 0
        env_shortterm = 0.0 if shortterm <= -70.0 else target_i - measured_i
    else:
        above_threshold = 1
        env_shortterm = 0.0 if shortterm <= -70.0 else target_i - shortterm
    init_gain = db_to_amp(env_shortterm)
    delta = [init_gain] * 30
    prev_delta = delta[index]
    gains[0] = delta[index]

    out_idx = 1
    for t in range(30, windows):
        gain = gaussian_filter_delta(delta, weights, (index + 10) if index + 10 < 30 else index + 10 - 30)
        if out_idx < windows:
            gains[out_idx] = gain
            out_idx += 1

        push_short(window_sums[t])
        add_hist_block(t)
        global_loudness = gated_loudness(hist, energies, boundaries)
        shortterm = energy_to_loudness(short_sum / float(frames_per_window * 30))
        rel_thresh = relative_threshold(hist, energies, boundaries)
        if above_threshold == 0:
            if shortterm > measured_thresh:
                prev_delta *= 1.0058
            # Source checks output shortterm here; no output-state port yet.
            if shortterm >= target_i:
                above_threshold = 1
        if shortterm < rel_thresh or shortterm <= -70.0 or above_threshold == 0:
            delta[index] = prev_delta
        else:
            diff = shortterm - global_loudness if math.isfinite(global_loudness) else 0.0
            limit = target_lra / 2.0
            env_global = diff if abs(diff) < limit else (limit if diff > 0 else -limit)
            env_shortterm = target_i - shortterm
            delta[index] = db_to_amp(env_global + env_shortterm)
        prev_delta = delta[index]
        index = (index + 1) % 30

    final_gain = gaussian_filter_delta(delta, weights, (index + 10) if index + 10 < 30 else index + 10 - 30)
    while out_idx < windows:
        gains[out_idx] = final_gain
        out_idx += 1
    return array.array('f', [max(0.0, float(g)) for g in gains])
