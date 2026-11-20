#include <math.h>
#include <stdint.h>

static int channel_slot(uint32_t channels, uint32_t c) {
    if (channels == 4U) {
        if (c == 0U) return 0;
        if (c == 1U) return 1;
        if (c == 2U) return 3;
        if (c == 3U) return 4;
        return -1;
    }
    if (channels == 5U) {
        if (c == 0U) return 0;
        if (c == 1U) return 1;
        if (c == 2U) return 2;
        if (c == 3U) return 3;
        if (c == 4U) return 4;
        return -1;
    }
    if (c == 0U) return 0;
    if (c == 1U) return 1;
    if (c == 2U) return 2;
    if (c == 4U) return 3;
    if (c == 5U) return 4;
    return -1;
}

static uint32_t float_abs_bits(double x) {
    union {
        float f;
        uint32_t u;
    } bits;
    bits.f = (float)fabs(x);
    return bits.u;
}

static double native_db_to_amp(double db) {
    return pow(10.0, db / 20.0);
}

static double native_energy_to_loudness(double energy) {
    if (energy <= 0.0) return -INFINITY;
    return 10.0 * log10(energy) - 0.691;
}

static int native_hist_index_from_boundaries(double energy, const double *boundaries) {
    int lo = 0;
    int hi = 1000;
    while (hi - lo != 1) {
        int mid = (lo + hi) / 2;
        if (energy >= boundaries[mid]) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return lo;
}

static double native_gated_loudness_lut_boundaries(
    const uint32_t *hist,
    const double *energies,
    const double *boundaries
) {
    double total = 0.0;
    uint32_t count = 0U;
    for (int i = 0; i < 1000; i++) {
        total += (double)hist[i] * energies[i];
        count += hist[i];
    }
    if (count == 0U) return -INFINITY;
    double rel = (total / (double)count) * 0.1;
    int start;
    if (rel < boundaries[0]) {
        start = 0;
    } else {
        start = native_hist_index_from_boundaries(rel, boundaries);
        if (rel > energies[start] && start < 999) start++;
    }
    double gated = 0.0;
    uint32_t gated_count = 0U;
    for (int i = start; i < 1000; i++) {
        gated += (double)hist[i] * energies[i];
        gated_count += hist[i];
    }
    if (gated_count == 0U) return -INFINITY;
    return native_energy_to_loudness(gated / (double)gated_count);
}

static double native_relative_threshold_lut(const uint32_t *hist, const double *energies) {
    double total = 0.0;
    uint32_t count = 0U;
    for (int i = 0; i < 1000; i++) {
        total += (double)hist[i] * energies[i];
        count += hist[i];
    }
    if (count == 0U) return -70.0;
    return native_energy_to_loudness((total / (double)count) * 0.1);
}

static double native_gaussian_filter(double *delta, const double *weights, int index) {
    double result = 0.0;
    index = index - 10 > 0 ? index - 10 : index + 20;
    for (int i = 0; i < 21; i++) {
        int j = index + i;
        if (j >= 30) j -= 30;
        result += delta[j] * weights[i];
    }
    return result;
}

static void write_source_start_states(
    double *source_start_states,
    uint32_t channels,
    uint32_t window,
    const double *v1,
    const double *v2,
    const double *v3,
    const double *v4
) {
    if (!source_start_states || channels != 2U) return;
    for (uint32_t c = 0U; c < channels; c++) {
        const uint64_t base = (((uint64_t)window * (uint64_t)channels) + (uint64_t)c) * 4ULL;
        source_start_states[base + 0U] = v1[c];
        source_start_states[base + 1U] = v2[c];
        source_start_states[base + 2U] = v3[c];
        source_start_states[base + 3U] = v4[c];
    }
}

static int process_channel_stats_strided(
    const double *input,
    uint32_t frames,
    uint32_t channels,
    uint32_t input_channels,
    uint32_t channel_offset,
    uint32_t frames_per_window,
    uint32_t global_frame_offset,
    double *channel_sums,
    uint32_t *peak_bits,
    double *states,
    double *source_start_states,
    const double *b,
    const double *a,
    double *compact_output
) {
    if (!input || !channel_sums || !peak_bits || !states || !b || !a) return 1;
    if (channels == 0U || channels > 16U || frames_per_window == 0U) return 2;
    if (input_channels == 0U || channel_offset + channels > input_channels) return 3;

    const double a1 = a[1];
    const double a2 = a[2];
    const double a3 = a[3];
    const double a4 = a[4];
    const double b0 = b[0];
    const double b1 = b[1];
    const double b2 = b[2];
    const double b3 = b[3];
    const double b4 = b[4];

    double v1[16];
    double v2[16];
    double v3[16];
    double v4[16];
    double window_sums[16];
    int slots[16];
    double weights[16];
    for (uint32_t c = 0U; c < channels; c++) {
        v1[c] = states[c * 4U + 0U];
        v2[c] = states[c * 4U + 1U];
        v3[c] = states[c * 4U + 2U];
        v4[c] = states[c * 4U + 3U];
        window_sums[c] = 0.0;
        slots[c] = channel_slot(channels, c);
        weights[c] = slots[c] >= 3 ? 1.41 : 1.0;
    }

    uint32_t current_w = global_frame_offset / frames_per_window;
    uint32_t window_peak_bits = 0U;
    if ((global_frame_offset % frames_per_window) == 0U) {
        write_source_start_states(source_start_states, channels, current_w, v1, v2, v3, v4);
    }

    for (uint32_t i = 0U; i < frames; i++) {
        const uint32_t w = (global_frame_offset + i) / frames_per_window;
        if (w != current_w) {
            if (window_peak_bits != 0U && window_peak_bits > peak_bits[current_w]) peak_bits[current_w] = window_peak_bits;
            for (uint32_t c = 0U; c < channels; c++) {
                if (slots[c] >= 0) channel_sums[((uint64_t)current_w * (uint64_t)channels) + (uint64_t)c] = window_sums[c];
                window_sums[c] = 0.0;
            }
            current_w = w;
            window_peak_bits = 0U;
            write_source_start_states(source_start_states, channels, current_w, v1, v2, v3, v4);
        }

        const uint64_t frame_base = (uint64_t)i * (uint64_t)input_channels + (uint64_t)channel_offset;
        const uint64_t compact_base = (uint64_t)i * (uint64_t)channels;
        for (uint32_t c = 0U; c < channels; c++) {
            const double x = input[frame_base + (uint64_t)c];
            if (compact_output) compact_output[compact_base + (uint64_t)c] = x;
            const uint32_t bits = float_abs_bits(x);
            if (bits > window_peak_bits) window_peak_bits = bits;
            if (slots[c] < 0) continue;

            double v0 = x;
            v0 = v0 - (a1 * v1[c]);
            v0 = v0 - (a2 * v2[c]);
            v0 = v0 - (a3 * v3[c]);
            v0 = v0 - (a4 * v4[c]);
            double y = b0 * v0;
            y = y + (b1 * v1[c]);
            y = y + (b2 * v2[c]);
            y = y + (b3 * v3[c]);
            y = y + (b4 * v4[c]);
            window_sums[c] += y * y * weights[c];
            v4[c] = v3[c];
            v3[c] = v2[c];
            v2[c] = v1[c];
            v1[c] = v0;
        }
    }

    if (frames > 0U) {
        if (window_peak_bits != 0U && window_peak_bits > peak_bits[current_w]) peak_bits[current_w] = window_peak_bits;
        for (uint32_t c = 0U; c < channels; c++) {
            if (slots[c] >= 0) channel_sums[((uint64_t)current_w * (uint64_t)channels) + (uint64_t)c] = window_sums[c];
        }
    }

    for (uint32_t c = 0U; c < channels; c++) {
        states[c * 4U + 0U] = v1[c];
        states[c * 4U + 1U] = v2[c];
        states[c * 4U + 2U] = v3[c];
        states[c * 4U + 3U] = v4[c];
    }
    return 0;
}

int opx_loudnorm_channel_stats_f64_process(
    const double *input,
    uint32_t frames,
    uint32_t channels,
    uint32_t frames_per_window,
    uint32_t global_frame_offset,
    double *channel_sums,
    uint32_t *peak_bits,
    double *states,
    double *source_start_states,
    const double *b,
    const double *a
) {
    return process_channel_stats_strided(
        input,
        frames,
        channels,
        channels,
        0U,
        frames_per_window,
        global_frame_offset,
        channel_sums,
        peak_bits,
        states,
        source_start_states,
        b,
        a,
        0
    );
}

int opx_loudnorm_channel_stats_f64_process_offset(
    const double *input,
    uint32_t frames,
    uint32_t channels,
    uint32_t input_channels,
    uint32_t channel_offset,
    uint32_t frames_per_window,
    uint32_t global_frame_offset,
    double *channel_sums,
    uint32_t *peak_bits,
    double *states,
    double *source_start_states,
    const double *b,
    const double *a,
    double *compact_output
) {
    return process_channel_stats_strided(
        input,
        frames,
        channels,
        input_channels,
        channel_offset,
        frames_per_window,
        global_frame_offset,
        channel_sums,
        peak_bits,
        states,
        source_start_states,
        b,
        a,
        compact_output
    );
}

int opx_loudnorm_output_sums_f64_process(
    const double *input,
    uint32_t frames,
    uint32_t channels,
    uint32_t frames_per_window,
    uint32_t global_frame_offset,
    double *window_sums_out,
    uint32_t *state_i,
    double *state_d,
    const double *b,
    const double *a
) {
    if (!input || !window_sums_out || !state_i || !state_d || !b || !a) return 1;
    if (channels == 0U || channels > 16U || frames_per_window == 0U) return 2;

    const double a1 = a[1];
    const double a2 = a[2];
    const double a3 = a[3];
    const double a4 = a[4];
    const double b0 = b[0];
    const double b1 = b[1];
    const double b2 = b[2];
    const double b3 = b[3];
    const double b4 = b[4];

    double v1[16];
    double v2[16];
    double v3[16];
    double v4[16];
    int slots[16];
    double weights[16];
    for (uint32_t c = 0U; c < channels; c++) {
        v1[c] = state_d[c * 4U + 0U];
        v2[c] = state_d[c * 4U + 1U];
        v3[c] = state_d[c * 4U + 2U];
        v4[c] = state_d[c * 4U + 3U];
        slots[c] = channel_slot(channels, c);
        weights[c] = slots[c] >= 3 ? 1.41 : 1.0;
    }

    uint32_t window_index = state_i[0];
    uint32_t window_count = state_i[1];
    if (window_index == 0U && window_count == 0U && global_frame_offset > 0U) {
        window_index = global_frame_offset / frames_per_window;
        window_count = global_frame_offset % frames_per_window;
    }
    double window_sum = state_d[(uint64_t)channels * 4ULL];

    for (uint32_t i = 0U; i < frames; i++) {
        const uint64_t frame_base = (uint64_t)i * (uint64_t)channels;
        double frame_sum = 0.0;
        for (uint32_t c = 0U; c < channels; c++) {
            if (slots[c] < 0) continue;
            const double x = input[frame_base + (uint64_t)c];
            double v0 = x;
            v0 = v0 - (a1 * v1[c]);
            v0 = v0 - (a2 * v2[c]);
            v0 = v0 - (a3 * v3[c]);
            v0 = v0 - (a4 * v4[c]);
            double y = b0 * v0;
            y = y + (b1 * v1[c]);
            y = y + (b2 * v2[c]);
            y = y + (b3 * v3[c]);
            y = y + (b4 * v4[c]);
            frame_sum += y * y * weights[c];
            v4[c] = v3[c];
            v3[c] = v2[c];
            v2[c] = v1[c];
            v1[c] = v0;
        }
        window_sum += frame_sum;
        window_count++;
        if (window_count == frames_per_window) {
            window_sums_out[window_index] = window_sum;
            window_index++;
            window_sum = 0.0;
            window_count = 0;
        }
    }

    if (frames > 0U && window_count > 0U) window_sums_out[window_index] = window_sum;
    state_i[0] = window_index;
    state_i[1] = window_count;
    state_d[(uint64_t)channels * 4ULL] = window_sum;
    for (uint32_t c = 0U; c < channels; c++) {
        state_d[c * 4U + 0U] = v1[c];
        state_d[c * 4U + 1U] = v2[c];
        state_d[c * 4U + 2U] = v3[c];
        state_d[c * 4U + 3U] = v4[c];
    }
    return 0;
}

int opx_loudnorm_gain_plan_f64_process(
    const double *window_sums,
    uint32_t windows,
    uint32_t frames_per_window,
    float target_i_arg,
    float target_lra_arg,
    float target_tp_arg,
    const double *hist_energies,
    const double *hist_boundaries,
    float measured_i_arg,
    float measured_thresh_arg,
    float offset_db_arg,
    uint32_t linear_mode,
    float *gains,
    float *gains_next,
    float *metrics
) {
    (void)target_tp_arg;
    if (!window_sums || !hist_energies || !hist_boundaries || !gains || !gains_next || !metrics) return 1;
    if (frames_per_window == 0U) return 2;

    uint32_t hist[1000];
    for (int i = 0; i < 1000; i++) hist[i] = 0U;
    const double weights[21] = {
        0.0019290645132252328,
        0.0041893491230893792,
        0.0083848200351896961,
        0.015466367540072898,
        0.026292403974220366,
        0.041192642776781974,
        0.059478006514445653,
        0.079148108748625767,
        0.097067103129731144,
        0.10971120494447856,
        0.11428185740027867,
        0.10971120494447856,
        0.097067103129731144,
        0.079148108748625767,
        0.059478006514445653,
        0.041192642776781974,
        0.026292403974220366,
        0.015466367540072898,
        0.0083848200351896961,
        0.0041893491230893792,
        0.0019290645132252328,
    };

    double short_ring[30];
    double out_short_ring[30];
    double delta[30];
    for (int i = 0; i < 30; i++) {
        short_ring[i] = 0.0;
        out_short_ring[i] = 0.0;
        delta[i] = 1.0;
    }
    double short_sum = 0.0;
    double out_short_sum = 0.0;
    int short_index = 0;
    int out_short_index = 0;
    int short_count = 0;
    int out_short_count = 0;
    int index = 1;
    int above_threshold = 0;
    double prev_delta = 1.0;
    const double target_i = (double)target_i_arg;
    const double target_lra = (double)target_lra_arg;
    const double measured_i = (double)measured_i_arg;
    const double measured_thresh = (double)measured_thresh_arg;
    const double offset_amp = native_db_to_amp((double)offset_db_arg);

    for (uint32_t i = 0U; i < windows; i++) {
        gains[i] = (float)offset_amp;
        gains_next[i] = (float)offset_amp;
    }

    if (linear_mode == 0U) {
        const uint32_t first = windows < 30U ? windows : 30U;
        for (uint32_t t = 0U; t < first; t++) {
            if (short_count == 30) short_sum -= short_ring[short_index]; else short_count++;
            short_ring[short_index] = window_sums[t];
            short_sum += window_sums[t];
            short_index = (short_index + 1) % 30;
            if (t >= 3U) {
                double e = (window_sums[t] + window_sums[t - 1U] + window_sums[t - 2U] + window_sums[t - 3U]) / (double)(frames_per_window * 4U);
                if (e >= hist_boundaries[0]) hist[native_hist_index_from_boundaries(e, hist_boundaries)]++;
            }
        }

        double shortterm = short_count > 0 ? native_energy_to_loudness(short_sum / (double)(frames_per_window * 30U)) : -INFINITY;
        double env_shortterm;
        if (shortterm < measured_thresh) {
            above_threshold = 0;
            env_shortterm = shortterm <= -70.0 ? 0.0 : target_i - measured_i;
        } else {
            above_threshold = 1;
            env_shortterm = shortterm <= -70.0 ? 0.0 : target_i - shortterm;
        }
        double init_gain = native_db_to_amp(env_shortterm);
        for (int i = 0; i < 30; i++) delta[i] = init_gain;
        prev_delta = delta[index];
        if (windows > 0U) {
            gains[0] = (float)(delta[index] * offset_amp);
            gains_next[0] = gains[0];
            out_short_ring[out_short_index] = window_sums[0] * (double)gains[0] * (double)gains[0];
            out_short_sum += out_short_ring[out_short_index];
            out_short_index = (out_short_index + 1) % 30;
            out_short_count = 1;
        }

        uint32_t out_idx = 1U;
        for (uint32_t t = 30U; t < windows; t++) {
            double gain = native_gaussian_filter(delta, weights, (index + 10) < 30 ? (index + 10) : (index + 10 - 30));
            double next_gain = native_gaussian_filter(delta, weights, (index + 11) < 30 ? (index + 11) : (index + 11 - 30));
            if (out_idx < windows) {
                const double effective_gain = gain * offset_amp;
                const double effective_next_gain = next_gain * offset_amp;
                gains[out_idx] = (float)effective_gain;
                gains_next[out_idx] = (float)effective_next_gain;
                if (out_short_count == 30) out_short_sum -= out_short_ring[out_short_index]; else out_short_count++;
                out_short_ring[out_short_index] = window_sums[out_idx] * effective_gain * effective_gain;
                out_short_sum += out_short_ring[out_short_index];
                out_short_index = (out_short_index + 1) % 30;
                out_idx++;
            }

            if (short_count == 30) short_sum -= short_ring[short_index]; else short_count++;
            short_ring[short_index] = window_sums[t];
            short_sum += window_sums[t];
            short_index = (short_index + 1) % 30;
            double e = (window_sums[t] + window_sums[t - 1U] + window_sums[t - 2U] + window_sums[t - 3U]) / (double)(frames_per_window * 4U);
            if (e >= hist_boundaries[0]) hist[native_hist_index_from_boundaries(e, hist_boundaries)]++;

            const double global = native_gated_loudness_lut_boundaries(hist, hist_energies, hist_boundaries);
            shortterm = native_energy_to_loudness(short_sum / (double)(frames_per_window * 30U));
            const double relative_threshold = native_relative_threshold_lut(hist, hist_energies);
            if (above_threshold == 0) {
                double shortterm_out = native_energy_to_loudness(out_short_sum / (double)(frames_per_window * 30U));
                if (shortterm > measured_thresh) prev_delta *= 1.0058;
                if (shortterm_out >= target_i) above_threshold = 1;
            }
            if (shortterm < relative_threshold || shortterm <= -70.0 || above_threshold == 0) {
                delta[index] = prev_delta;
            } else {
                double diff = isfinite(global) ? (shortterm - global) : 0.0;
                double limit = target_lra / 2.0;
                double env_global = fabs(diff) < limit ? diff : (diff < 0.0 ? -limit : limit);
                env_shortterm = target_i - shortterm;
                delta[index] = native_db_to_amp(env_global + env_shortterm);
            }
            prev_delta = delta[index];
            index++;
            if (index >= 30) index -= 30;
        }
        double final_gain = native_gaussian_filter(delta, weights, (index + 10) < 30 ? (index + 10) : (index + 10 - 30));
        while (out_idx < windows) {
            gains[out_idx] = (float)(final_gain * offset_amp);
            gains_next[out_idx] = gains[out_idx];
            out_idx++;
        }

        for (uint32_t i = 0U; i < windows; i++) {
            if (gains[i] < 0.0f) gains[i] = 0.0f;
            if (gains_next[i] < 0.0f) gains_next[i] = 0.0f;
        }
    }

    for (int i = 0; i < 1000; i++) hist[i] = 0U;
    for (uint32_t t = 3U; t < windows; t++) {
        double energy = (window_sums[t] + window_sums[t - 1U] + window_sums[t - 2U] + window_sums[t - 3U]) / (double)(frames_per_window * 4U);
        if (energy >= hist_boundaries[0]) hist[native_hist_index_from_boundaries(energy, hist_boundaries)]++;
    }

    double input_i = native_gated_loudness_lut_boundaries(hist, hist_energies, hist_boundaries);
    float gain_min = windows > 0U ? gains[0] : 1.0f;
    float gain_max = windows > 0U ? gains[0] : 1.0f;
    for (uint32_t i = 1U; i < windows; i++) {
        float g = gains[i];
        if (g < gain_min) gain_min = g;
        if (g > gain_max) gain_max = g;
    }
    metrics[0] = (float)input_i;
    metrics[1] = gain_min;
    metrics[2] = gain_max;
    return 0;
}
