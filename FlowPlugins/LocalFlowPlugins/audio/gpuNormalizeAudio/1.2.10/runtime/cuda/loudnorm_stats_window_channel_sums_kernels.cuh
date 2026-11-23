extern "C" __global__ void kweight_window_sums_f64_channel_kernel(
    const double *input,
    double *channel_sums,
    unsigned int *peak_bits,
    double *states,
    double *source_start_states,
    unsigned int frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int global_frame_offset,
    const double *b,
    const double *a
) {
    const unsigned int c = blockIdx.x;
    if (c >= channels || threadIdx.x != 0) return;
    int slot = -1;
    if (channels == 4) {
        if (c == 0) slot = 0;
        else if (c == 1) slot = 1;
        else if (c == 2) slot = 3;
        else if (c == 3) slot = 4;
    } else if (channels == 5) {
        if (c == 0) slot = 0;
        else if (c == 1) slot = 1;
        else if (c == 2) slot = 2;
        else if (c == 3) slot = 3;
        else if (c == 4) slot = 4;
    } else {
        if (c == 0) slot = 0;
        else if (c == 1) slot = 1;
        else if (c == 2) slot = 2;
        else if (c == 4) slot = 3;
        else if (c == 5) slot = 4;
    }
    if (slot < 0) {
        if (!peak_bits || frames_per_window == 0U) return;
        if (!LOUDNORM_EXACT_GENERIC_LIMITER && (global_frame_offset % frames_per_window) == 0U) {
            const unsigned int first_w = global_frame_offset / frames_per_window;
            const unsigned int local_windows = (frames + frames_per_window - 1U) / frames_per_window;
            for (unsigned int local_w = 0; local_w < local_windows; local_w++) {
                const unsigned int start = local_w * frames_per_window;
                if (start >= frames) break;
                unsigned int end = start + frames_per_window;
                if (end > frames) end = frames;
                unsigned int window_peak_bits = 0U;
                for (unsigned int i = start; i < end; i++) {
                    const float ax = (float)fabs(input[(unsigned long long)i * channels + c]);
                    const unsigned int bits = __float_as_uint(ax);
                    if (bits > window_peak_bits) window_peak_bits = bits;
                }
                if (window_peak_bits != 0U) atomicMax(&peak_bits[first_w + local_w], window_peak_bits);
            }
            return;
        }
        unsigned int current_w = global_frame_offset / frames_per_window;
        unsigned int window_peak_bits = 0U;
        for (unsigned int i = 0; i < frames; i++) {
            const unsigned int w = (global_frame_offset + i) / frames_per_window;
            if (w != current_w) {
                if (window_peak_bits != 0U) atomicMax(&peak_bits[current_w], window_peak_bits);
                current_w = w;
                window_peak_bits = 0U;
            }
            const float ax = (float)fabs(input[(unsigned long long)i * channels + c]);
            const unsigned int bits = __float_as_uint(ax);
            if (bits > window_peak_bits) window_peak_bits = bits;
        }
        if (frames > 0 && window_peak_bits != 0U) atomicMax(&peak_bits[current_w], window_peak_bits);
        return;
    }
    const double weight = slot >= 3 ? 1.41 : 1.0;
    const double a1 = a[1];
    const double a2 = a[2];
    const double a3 = a[3];
    const double a4 = a[4];
    const double b0 = b[0];
    const double b1 = b[1];
    const double b2 = b[2];
    const double b3 = b[3];
    const double b4 = b[4];
    double v1 = states[c * 4 + 0];
    double v2 = states[c * 4 + 1];
    double v3 = states[c * 4 + 2];
    double v4 = states[c * 4 + 3];
    if (!LOUDNORM_EXACT_GENERIC_LIMITER && (channels == 6U || channels == 2U) && (global_frame_offset % frames_per_window) == 0U) {
        const unsigned int first_w = global_frame_offset / frames_per_window;
        const unsigned int local_windows = (frames + frames_per_window - 1U) / frames_per_window;
        for (unsigned int local_w = 0; local_w < local_windows; local_w++) {
            const unsigned int start = local_w * frames_per_window;
            if (start >= frames) break;
            unsigned int end = start + frames_per_window;
            if (end > frames) end = frames;
            const unsigned int global_w = first_w + local_w;
            if (source_start_states && channels == 2U) {
                const unsigned long long state_base = ((unsigned long long)global_w * channels + c) * 4ULL;
                source_start_states[state_base + 0] = v1;
                source_start_states[state_base + 1] = v2;
                source_start_states[state_base + 2] = v3;
                source_start_states[state_base + 3] = v4;
            }
            double window_sum = 0.0;
            unsigned int window_peak_bits = 0U;
            for (unsigned int i = start; i < end; i++) {
                const double x = input[(unsigned long long)i * channels + c];
                if (peak_bits) {
                    const unsigned int bits = __float_as_uint((float)fabs(x));
                    if (bits > window_peak_bits) window_peak_bits = bits;
                }
                double v0 = x;
                v0 = __dsub_rn(v0, __dmul_rn(a1, v1));
                v0 = __dsub_rn(v0, __dmul_rn(a2, v2));
                v0 = __dsub_rn(v0, __dmul_rn(a3, v3));
                v0 = __dsub_rn(v0, __dmul_rn(a4, v4));
                double y = __dmul_rn(b0, v0);
                y = __dadd_rn(y, __dmul_rn(b1, v1));
                y = __dadd_rn(y, __dmul_rn(b2, v2));
                y = __dadd_rn(y, __dmul_rn(b3, v3));
                y = __dadd_rn(y, __dmul_rn(b4, v4));
                window_sum += y * y * weight;
                v4 = v3;
                v3 = v2;
                v2 = v1;
                v1 = v0;
            }
            if (peak_bits && window_peak_bits != 0U) atomicMax(&peak_bits[global_w], window_peak_bits);
            channel_sums[((unsigned long long)global_w * channels) + c] = window_sum;
        }
        states[c * 4 + 0] = v1;
        states[c * 4 + 1] = v2;
        states[c * 4 + 2] = v3;
        states[c * 4 + 3] = v4;
        return;
    }
    unsigned int current_w = global_frame_offset / frames_per_window;
    double window_sum = 0.0;
    unsigned int window_peak_bits = 0U;
    if (source_start_states && channels == 2U && (global_frame_offset % frames_per_window) == 0U) {
        const unsigned long long state_base = ((unsigned long long)current_w * channels + c) * 4ULL;
        source_start_states[state_base + 0] = v1;
        source_start_states[state_base + 1] = v2;
        source_start_states[state_base + 2] = v3;
        source_start_states[state_base + 3] = v4;
    }
    for (unsigned int i = 0; i < frames; i++) {
        const unsigned int w = (global_frame_offset + i) / frames_per_window;
        if (w != current_w) {
            if (peak_bits && window_peak_bits != 0U) atomicMax(&peak_bits[current_w], window_peak_bits);
            channel_sums[((unsigned long long)current_w * channels) + c] = window_sum;
            current_w = w;
            window_sum = 0.0;
            window_peak_bits = 0U;
            if (source_start_states && channels == 2U) {
                const unsigned long long state_base = ((unsigned long long)current_w * channels + c) * 4ULL;
                source_start_states[state_base + 0] = v1;
                source_start_states[state_base + 1] = v2;
                source_start_states[state_base + 2] = v3;
                source_start_states[state_base + 3] = v4;
            }
        }
        const double x = input[(unsigned long long)i * channels + c];
        if (peak_bits) {
            const unsigned int bits = __float_as_uint((float)fabs(x));
            if (bits > window_peak_bits) window_peak_bits = bits;
        }
        double v0 = x;
        v0 = __dsub_rn(v0, __dmul_rn(a1, v1));
        v0 = __dsub_rn(v0, __dmul_rn(a2, v2));
        v0 = __dsub_rn(v0, __dmul_rn(a3, v3));
        v0 = __dsub_rn(v0, __dmul_rn(a4, v4));
        double y = __dmul_rn(b0, v0);
        y = __dadd_rn(y, __dmul_rn(b1, v1));
        y = __dadd_rn(y, __dmul_rn(b2, v2));
        y = __dadd_rn(y, __dmul_rn(b3, v3));
        y = __dadd_rn(y, __dmul_rn(b4, v4));
        window_sum += y * y * weight;
        v4 = v3;
        v3 = v2;
        v2 = v1;
        v1 = v0;
    }
    if (frames > 0) {
        if (peak_bits && window_peak_bits != 0U) atomicMax(&peak_bits[current_w], window_peak_bits);
        channel_sums[((unsigned long long)current_w * channels) + c] = window_sum;
    }
    states[c * 4 + 0] = v1;
    states[c * 4 + 1] = v2;
    states[c * 4 + 2] = v3;
    states[c * 4 + 3] = v4;
}
