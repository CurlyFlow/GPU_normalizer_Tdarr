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
