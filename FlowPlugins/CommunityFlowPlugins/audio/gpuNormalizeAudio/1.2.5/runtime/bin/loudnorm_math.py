from __future__ import annotations

import math


def db_to_amp(db):
    return 10.0 ** (db / 20.0)


def amp_to_db(amp):
    return 20.0 * math.log10(max(float(amp), 1e-12))


def frame_size(rate, frame_len_msec):
    size = round(float(rate) * (float(frame_len_msec) / 1000.0))
    return int(size) + (int(size) % 2)


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
    loudness, _threshold = input_loudness_threshold_from_window_sums(window_sums, frames_per_window)
    return loudness


def input_loudness_threshold_from_window_sums(window_sums, frames_per_window):
    energies, boundaries = histogram_tables()
    hist = [0] * 1000
    for t in range(3, len(window_sums)):
        energy = sum(window_sums[t - 3:t + 1]) / float(frames_per_window * 4)
        if energy >= boundaries[0]:
            hist[histogram_index(energy, boundaries)] += 1
    return gated_loudness(hist, energies, boundaries), relative_threshold(hist, energies, boundaries)


def input_loudness_range_from_window_sums(window_sums, frames_per_window):
    energies, boundaries = histogram_tables()
    hist = [0] * 1000
    for t in range(29, len(window_sums), 10):
        energy = sum(window_sums[t - 29:t + 1]) / float(frames_per_window * 30)
        if energy >= boundaries[0]:
            hist[histogram_index(energy, boundaries)] += 1

    stl_size = sum(hist)
    if stl_size <= 0:
        return 0.0
    stl_power = sum(count * energy for count, energy in zip(hist, energies)) / float(stl_size)
    stl_integrated = stl_power * (10.0 ** (-20.0 / 10.0))
    if stl_integrated < boundaries[0]:
        start = 0
    else:
        start = histogram_index(stl_integrated, boundaries)
        if stl_integrated > energies[start]:
            start += 1

    gated_size = sum(hist[start:])
    if gated_size <= 0:
        return 0.0
    percentile_low = int((gated_size - 1) * 0.1 + 0.5)
    percentile_high = int((gated_size - 1) * 0.95 + 0.5)
    count = 0
    idx = start
    while count <= percentile_low and idx < 1000:
        count += hist[idx]
        idx += 1
    low_energy = energies[idx - 1]
    while count <= percentile_high and idx < 1000:
        count += hist[idx]
        idx += 1
    high_energy = energies[idx - 1]
    return energy_to_loudness(high_energy) - energy_to_loudness(low_energy)


def relative_threshold(hist, energies, boundaries):
    count = sum(hist)
    if count <= 0:
        return -70.0
    avg = sum(c * e for c, e in zip(hist, energies)) / count
    return energy_to_loudness(avg * (10.0 ** (-10.0 / 10.0)))
