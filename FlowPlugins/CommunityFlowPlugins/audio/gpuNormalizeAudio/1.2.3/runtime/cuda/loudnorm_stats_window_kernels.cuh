extern "C" __global__ void kweight_window_stats_kernel(
    const float *input,
    float *sums,
    unsigned int *peak_bits,
    unsigned int frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int global_frame_offset,
    const double *b,
    const double *a,
    double *states
) {
    const unsigned int c = blockIdx.x;
    if (c >= channels || threadIdx.x != 0) return;
    const int mapped_unused = (channels == 6 && c == 3);
    double weight = 1.0;
    if (channels == 6 && c >= 4) weight = 1.41;
    double v1 = states[c * 4 + 0];
    double v2 = states[c * 4 + 1];
    double v3 = states[c * 4 + 2];
    double v4 = states[c * 4 + 3];
    unsigned int current_w = global_frame_offset / frames_per_window;
    float window_sum = 0.0f;
    float window_peak = 0.0f;
    for (unsigned int i = 0; i < frames; i++) {
        const float x_f = input[(unsigned long long)i * channels + c];
        const float ax = fabsf(x_f);
        const unsigned int w = (global_frame_offset + i) / frames_per_window;
        if (w != current_w) {
            if (window_peak > 0.0f) atomicMax(&peak_bits[current_w], __float_as_uint(window_peak));
            if (!mapped_unused && window_sum != 0.0f) atomicAdd(&sums[current_w], window_sum);
            current_w = w;
            window_sum = 0.0f;
            window_peak = 0.0f;
        }
        if (ax > window_peak) window_peak = ax;
        if (!mapped_unused) {
            const double x = (double)x_f;
            const double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
            const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
            window_sum += (float)(y * y * weight);
            v4 = v3;
            v3 = v2;
            v2 = v1;
            v1 = v0;
        }
    }
    if (frames > 0) {
        if (window_peak > 0.0f) atomicMax(&peak_bits[current_w], __float_as_uint(window_peak));
        if (!mapped_unused && window_sum != 0.0f) atomicAdd(&sums[current_w], window_sum);
    }
    states[c * 4 + 0] = v1;
    states[c * 4 + 1] = v2;
    states[c * 4 + 2] = v3;
    states[c * 4 + 3] = v4;
}

extern "C" __global__ void kweight_window_q_kernel(
    const float *input,
    double *q_states,
    unsigned int *peak_bits,
    unsigned int frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int global_window_offset,
    const double *a
) {
    const unsigned int local_windows = (frames + frames_per_window - 1) / frames_per_window;
    const unsigned int pairs = local_windows * channels;
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int pair = blockIdx.x * blockDim.x + threadIdx.x; pair < pairs; pair += stride) {
        const unsigned int local_w = pair / channels;
        const unsigned int c = pair - local_w * channels;
        const unsigned int start = local_w * frames_per_window;
        if (start >= frames) continue;
        unsigned int end = start + frames_per_window;
        if (end > frames) end = frames;
        const unsigned int global_w = global_window_offset + local_w;
        const unsigned long long q_base = ((unsigned long long)global_w * channels + c) * 4ULL;
        const int mapped_unused = (channels == 6 && c == 3);
        double v1 = 0.0;
        double v2 = 0.0;
        double v3 = 0.0;
        double v4 = 0.0;
        float window_peak = 0.0f;
        for (unsigned int i = start; i < end; i++) {
            const float x_f = input[(unsigned long long)i * channels + c];
            const float ax = fabsf(x_f);
            if (ax > window_peak) window_peak = ax;
            if (!mapped_unused) {
                const double x = (double)x_f;
                const double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
                v4 = v3;
                v3 = v2;
                v2 = v1;
                v1 = v0;
            }
        }
        if (window_peak > 0.0f) atomicMax(&peak_bits[global_w], __float_as_uint(window_peak));
        q_states[q_base + 0] = v1;
        q_states[q_base + 1] = v2;
        q_states[q_base + 2] = v3;
        q_states[q_base + 3] = v4;
    }
}

extern "C" __global__ void kweight_window_sums_kernel(
    const float *input,
    double *sums,
    const double *start_states,
    unsigned int frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int global_window_offset,
    const double *b,
    const double *a
) {
    const unsigned int local_windows = (frames + frames_per_window - 1) / frames_per_window;
    const unsigned int pairs = local_windows * channels;
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int pair = blockIdx.x * blockDim.x + threadIdx.x; pair < pairs; pair += stride) {
        const unsigned int local_w = pair / channels;
        const unsigned int c = pair - local_w * channels;
        const int mapped_unused = (channels == 6 && c == 3);
        if (mapped_unused) continue;
        const unsigned int start = local_w * frames_per_window;
        if (start >= frames) continue;
        unsigned int end = start + frames_per_window;
        if (end > frames) end = frames;
        const unsigned int global_w = global_window_offset + local_w;
        const unsigned long long state_base = ((unsigned long long)global_w * channels + c) * 4ULL;
        double weight = 1.0;
        if (channels == 6 && c >= 4) weight = 1.41;
        double v1 = start_states[state_base + 0];
        double v2 = start_states[state_base + 1];
        double v3 = start_states[state_base + 2];
        double v4 = start_states[state_base + 3];
        double window_sum = 0.0;
        for (unsigned int i = start; i < end; i++) {
            const float x_f = input[(unsigned long long)i * channels + c];
            const double x = (double)x_f;
            const double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
            const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
            window_sum += y * y * weight;
            v4 = v3;
            v3 = v2;
            v2 = v1;
            v1 = v0;
        }
        if (window_sum != 0.0) atomicAdd(&sums[global_w], window_sum);
    }
}

extern "C" __global__ void kweight_window_q_f64_kernel(
    const double *input,
    double *q_states,
    unsigned int *peak_bits,
    unsigned int frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int global_window_offset,
    const double *a
) {
    const unsigned int local_windows = (frames + frames_per_window - 1) / frames_per_window;
    const unsigned int pairs = local_windows * channels;
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int pair = blockIdx.x * blockDim.x + threadIdx.x; pair < pairs; pair += stride) {
        const unsigned int local_w = pair / channels;
        const unsigned int c = pair - local_w * channels;
        const unsigned int start = local_w * frames_per_window;
        if (start >= frames) continue;
        unsigned int end = start + frames_per_window;
        if (end > frames) end = frames;
        const unsigned int global_w = global_window_offset + local_w;
        const unsigned long long q_base = ((unsigned long long)global_w * channels + c) * 4ULL;
        const int mapped_unused = (channels == 6 && c == 3);
        double v1 = 0.0;
        double v2 = 0.0;
        double v3 = 0.0;
        double v4 = 0.0;
        float window_peak = 0.0f;
        for (unsigned int i = start; i < end; i++) {
            const double x = input[(unsigned long long)i * channels + c];
            const float ax = (float)fabs(x);
            if (ax > window_peak) window_peak = ax;
            if (!mapped_unused) {
                const double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
                v4 = v3;
                v3 = v2;
                v2 = v1;
                v1 = v0;
            }
        }
        if (window_peak > 0.0f) atomicMax(&peak_bits[global_w], __float_as_uint(window_peak));
        q_states[q_base + 0] = v1;
        q_states[q_base + 1] = v2;
        q_states[q_base + 2] = v3;
        q_states[q_base + 3] = v4;
    }
}

extern "C" __global__ void kweight_window_sums_f64_kernel(
    const double *input,
    double *sums,
    const double *start_states,
    unsigned int frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int global_window_offset,
    const double *b,
    const double *a
) {
    const unsigned int local_windows = (frames + frames_per_window - 1) / frames_per_window;
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int local_w = blockIdx.x * blockDim.x + threadIdx.x; local_w < local_windows; local_w += stride) {
        const unsigned int start = local_w * frames_per_window;
        if (start >= frames) continue;
        unsigned int end = start + frames_per_window;
        if (end > frames) end = frames;
        const unsigned int global_w = global_window_offset + local_w;
        double v1s[16];
        double v2s[16];
        double v3s[16];
        double v4s[16];
        for (unsigned int c = 0; c < channels && c < 16U; c++) {
            const unsigned long long state_base = ((unsigned long long)global_w * channels + c) * 4ULL;
            v1s[c] = start_states[state_base + 0];
            v2s[c] = start_states[state_base + 1];
            v3s[c] = start_states[state_base + 2];
            v4s[c] = start_states[state_base + 3];
        }
        double window_sum = 0.0;
        for (unsigned int i = start; i < end; i++) {
            double frame_sum = 0.0;
            for (unsigned int c = 0; c < channels && c < 16U; c++) {
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
                if (slot < 0) continue;
                const double x = input[(unsigned long long)i * channels + c];
                const double v0 = kweight_v0_rn_dev(x, a, v1s[c], v2s[c], v3s[c], v4s[c]);
                const double y = kweight_y_rn_dev(b, v0, v1s[c], v2s[c], v3s[c], v4s[c]);
                frame_sum += y * y * (slot >= 3 ? 1.41 : 1.0);
                v4s[c] = v3s[c];
                v3s[c] = v2s[c];
                v2s[c] = v1s[c];
                v1s[c] = v0;
            }
            window_sum += frame_sum;
        }
        sums[global_w] = window_sum;
    }
}

extern "C" __device__ void kweight_transition_matrix_dev(unsigned int frames, const double *a, double *p) {
    for (int i = 0; i < 16; i++) p[i] = 0.0;
    p[0] = 1.0;
    p[5] = 1.0;
    p[10] = 1.0;
    p[15] = 1.0;
    const double na1 = -a[1];
    const double na2 = -a[2];
    const double na3 = -a[3];
    const double na4 = -a[4];
    for (unsigned int i = 0; i < frames; i++) {
        double r0[4];
        r0[0] = __dadd_rn(__dadd_rn(__dmul_rn(na1, p[0]), __dmul_rn(na2, p[4])), __dadd_rn(__dmul_rn(na3, p[8]), __dmul_rn(na4, p[12])));
        r0[1] = __dadd_rn(__dadd_rn(__dmul_rn(na1, p[1]), __dmul_rn(na2, p[5])), __dadd_rn(__dmul_rn(na3, p[9]), __dmul_rn(na4, p[13])));
        r0[2] = __dadd_rn(__dadd_rn(__dmul_rn(na1, p[2]), __dmul_rn(na2, p[6])), __dadd_rn(__dmul_rn(na3, p[10]), __dmul_rn(na4, p[14])));
        r0[3] = __dadd_rn(__dadd_rn(__dmul_rn(na1, p[3]), __dmul_rn(na2, p[7])), __dadd_rn(__dmul_rn(na3, p[11]), __dmul_rn(na4, p[15])));
        for (int j = 0; j < 4; j++) {
            p[12 + j] = p[8 + j];
            p[8 + j] = p[4 + j];
            p[4 + j] = p[j];
            p[j] = r0[j];
        }
    }
}

extern "C" __global__ void kweight_build_start_states_f64_kernel(
    const double *q_states,
    double *start_states,
    unsigned int windows,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int total_frames,
    const double *a
) {
    const unsigned int c = blockIdx.x;
    if (c >= channels || threadIdx.x != 0) return;
    const int mapped_unused = (channels == 6U && c == 3U);
    double p_full[16];
    double p_last[16];
    kweight_transition_matrix_dev(frames_per_window, a, p_full);
    unsigned int last_len = frames_per_window;
    if (windows > 0U) {
        const unsigned int last_start = (windows - 1U) * frames_per_window;
        last_len = total_frames > last_start ? total_frames - last_start : 0U;
        if (last_len > frames_per_window) last_len = frames_per_window;
    }
    const int needs_last = last_len != frames_per_window;
    if (needs_last) kweight_transition_matrix_dev(last_len, a, p_last);
    double s0 = 0.0;
    double s1 = 0.0;
    double s2 = 0.0;
    double s3 = 0.0;
    for (unsigned int w = 0; w < windows; w++) {
        const unsigned long long base = ((unsigned long long)w * channels + c) * 4ULL;
        start_states[base + 0] = s0;
        start_states[base + 1] = s1;
        start_states[base + 2] = s2;
        start_states[base + 3] = s3;
        if (mapped_unused) continue;
        const double *p = (needs_last && w == windows - 1U) ? p_last : p_full;
        const double q0 = q_states[base + 0];
        const double q1 = q_states[base + 1];
        const double q2 = q_states[base + 2];
        const double q3 = q_states[base + 3];
        const double n0 = __dadd_rn(__dadd_rn(__dadd_rn(__dmul_rn(p[0], s0), __dmul_rn(p[1], s1)), __dadd_rn(__dmul_rn(p[2], s2), __dmul_rn(p[3], s3))), q0);
        const double n1 = __dadd_rn(__dadd_rn(__dadd_rn(__dmul_rn(p[4], s0), __dmul_rn(p[5], s1)), __dadd_rn(__dmul_rn(p[6], s2), __dmul_rn(p[7], s3))), q1);
        const double n2 = __dadd_rn(__dadd_rn(__dadd_rn(__dmul_rn(p[8], s0), __dmul_rn(p[9], s1)), __dadd_rn(__dmul_rn(p[10], s2), __dmul_rn(p[11], s3))), q2);
        const double n3 = __dadd_rn(__dadd_rn(__dadd_rn(__dmul_rn(p[12], s0), __dmul_rn(p[13], s1)), __dadd_rn(__dmul_rn(p[14], s2), __dmul_rn(p[15], s3))), q3);
        s0 = fabs(n0) < 2.2250738585072014e-308 ? 0.0 : n0;
        s1 = fabs(n1) < 2.2250738585072014e-308 ? 0.0 : n1;
        s2 = fabs(n2) < 2.2250738585072014e-308 ? 0.0 : n2;
        s3 = fabs(n3) < 2.2250738585072014e-308 ? 0.0 : n3;
    }
}

extern "C" __global__ void kweight_window_channel_sums_f64_prefix_kernel(
    const double *input,
    double *channel_sums,
    const double *start_states,
    unsigned int frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int global_window_offset,
    const double *b,
    const double *a
) {
    const unsigned int local_windows = (frames + frames_per_window - 1) / frames_per_window;
    const unsigned int pairs = local_windows * channels;
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int pair = blockIdx.x * blockDim.x + threadIdx.x; pair < pairs; pair += stride) {
        const unsigned int local_w = pair / channels;
        const unsigned int c = pair - local_w * channels;
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
        if (slot < 0) continue;
        const unsigned int start = local_w * frames_per_window;
        if (start >= frames) continue;
        unsigned int end = start + frames_per_window;
        if (end > frames) end = frames;
        const unsigned int global_w = global_window_offset + local_w;
        const unsigned long long state_base = ((unsigned long long)global_w * channels + c) * 4ULL;
        double v1 = start_states[state_base + 0];
        double v2 = start_states[state_base + 1];
        double v3 = start_states[state_base + 2];
        double v4 = start_states[state_base + 3];
        const double weight = slot >= 3 ? 1.41 : 1.0;
        double window_sum = 0.0;
        for (unsigned int i = start; i < end; i++) {
            const double x = input[(unsigned long long)i * channels + c];
            const double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
            const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
            window_sum += y * y * weight;
            v4 = v3;
            v3 = v2;
            v2 = v1;
            v1 = v0;
        }
        channel_sums[((unsigned long long)global_w * channels) + c] = window_sum;
    }
}

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

extern "C" __global__ void kweight_window_sums_f64_channel_source_energy_kernel(
    const double *input,
    double *channel_sums,
    unsigned int *peak_bits,
    double *states,
    double *source_start_states,
    double *source_energy,
    unsigned int source_energy_base_frame,
    unsigned int source_energy_frames,
    unsigned int frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int global_frame_offset,
    const double *b,
    const double *a
) {
    const unsigned int c = blockIdx.x;
    if (channels != 2U || c >= 2U || threadIdx.x != 0 || !source_energy) return;
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
    if ((global_frame_offset % frames_per_window) == 0U) {
        const unsigned int first_w = global_frame_offset / frames_per_window;
        const unsigned int local_windows = (frames + frames_per_window - 1U) / frames_per_window;
        for (unsigned int local_w = 0; local_w < local_windows; local_w++) {
            const unsigned int start = local_w * frames_per_window;
            if (start >= frames) break;
            unsigned int end = start + frames_per_window;
            if (end > frames) end = frames;
            const unsigned int global_w = first_w + local_w;
            if (source_start_states) {
                const unsigned long long state_base = ((unsigned long long)global_w * 2ULL + c) * 4ULL;
                source_start_states[state_base + 0] = v1;
                source_start_states[state_base + 1] = v2;
                source_start_states[state_base + 2] = v3;
                source_start_states[state_base + 3] = v4;
            }
            double window_sum = 0.0;
            unsigned int window_peak_bits = 0U;
            for (unsigned int i = start; i < end; i++) {
                const unsigned int frame = global_frame_offset + i;
                const double x = input[(unsigned long long)i * 2ULL + c];
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
                const double energy = y * y;
                window_sum += energy;
                if (frame >= source_energy_base_frame) {
                    const unsigned int local_frame = frame - source_energy_base_frame;
                    if (local_frame < source_energy_frames) source_energy[(unsigned long long)local_frame * 2ULL + c] = energy;
                }
                v4 = v3;
                v3 = v2;
                v2 = v1;
                v1 = v0;
            }
            if (peak_bits && window_peak_bits != 0U) atomicMax(&peak_bits[global_w], window_peak_bits);
            channel_sums[((unsigned long long)global_w * 2ULL) + c] = window_sum;
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
    if (source_start_states) {
        const unsigned long long state_base = ((unsigned long long)current_w * 2ULL + c) * 4ULL;
        source_start_states[state_base + 0] = v1;
        source_start_states[state_base + 1] = v2;
        source_start_states[state_base + 2] = v3;
        source_start_states[state_base + 3] = v4;
    }
    for (unsigned int i = 0; i < frames; i++) {
        const unsigned int frame = global_frame_offset + i;
        const unsigned int w = frame / frames_per_window;
        if (w != current_w) {
            if (peak_bits && window_peak_bits != 0U) atomicMax(&peak_bits[current_w], window_peak_bits);
            channel_sums[((unsigned long long)current_w * 2ULL) + c] = window_sum;
            current_w = w;
            window_sum = 0.0;
            window_peak_bits = 0U;
            if (source_start_states) {
                const unsigned long long state_base = ((unsigned long long)current_w * 2ULL + c) * 4ULL;
                source_start_states[state_base + 0] = v1;
                source_start_states[state_base + 1] = v2;
                source_start_states[state_base + 2] = v3;
                source_start_states[state_base + 3] = v4;
            }
        }
        const double x = input[(unsigned long long)i * 2ULL + c];
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
        const double energy = y * y;
        window_sum += energy;
        if (frame >= source_energy_base_frame) {
            const unsigned int local_frame = frame - source_energy_base_frame;
            if (local_frame < source_energy_frames) source_energy[(unsigned long long)local_frame * 2ULL + c] = energy;
        }
        v4 = v3;
        v3 = v2;
        v2 = v1;
        v1 = v0;
    }
    if (frames > 0) {
        if (peak_bits && window_peak_bits != 0U) atomicMax(&peak_bits[current_w], window_peak_bits);
        channel_sums[((unsigned long long)current_w * 2ULL) + c] = window_sum;
    }
    states[c * 4 + 0] = v1;
    states[c * 4 + 1] = v2;
    states[c * 4 + 2] = v3;
    states[c * 4 + 3] = v4;
}
