from __future__ import annotations

import array

from loudnorm_math import ebur128_transition_matrix


def build_start_states(q_states, windows, channels, frames_per_window, total_frames, a_coeffs):
    start_states = array.array('d', [0.0]) * (windows * channels * 4)
    matrix_cache = {}
    for c in range(channels):
        state = [0.0, 0.0, 0.0, 0.0]
        mapped_unused = channels == 6 and c == 3
        for w in range(windows):
            base = (w * channels + c) * 4
            start_states[base + 0] = state[0]
            start_states[base + 1] = state[1]
            start_states[base + 2] = state[2]
            start_states[base + 3] = state[3]
            if mapped_unused:
                continue
            length = min(frames_per_window, total_frames - w * frames_per_window)
            p = matrix_cache.get(length)
            if p is None:
                p = ebur128_transition_matrix(length, a_coeffs)
                matrix_cache[length] = p
            q0 = q_states[base + 0]
            q1 = q_states[base + 1]
            q2 = q_states[base + 2]
            q3 = q_states[base + 3]
            state = [
                p[0] * state[0] + p[1] * state[1] + p[2] * state[2] + p[3] * state[3] + q0,
                p[4] * state[0] + p[5] * state[1] + p[6] * state[2] + p[7] * state[3] + q1,
                p[8] * state[0] + p[9] * state[1] + p[10] * state[2] + p[11] * state[3] + q2,
                p[12] * state[0] + p[13] * state[1] + p[14] * state[2] + p[15] * state[3] + q3,
            ]
            state = [0.0 if abs(v) < 2.2250738585072014e-308 else v for v in state]
    return start_states
