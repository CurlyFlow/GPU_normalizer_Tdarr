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

extern "C" __global__ void kweight_window_q_f64_no_peaks_kernel(
    const double *input,
    double *q_states,
    unsigned int *peak_bits,
    unsigned int frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int global_window_offset,
    const double *a
) {
    (void)peak_bits;
    const unsigned int local_windows = (frames + frames_per_window - 1U) / frames_per_window;
    const unsigned int pairs = local_windows * channels;
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int pair = blockIdx.x * blockDim.x + threadIdx.x; pair < pairs; pair += stride) {
        const unsigned int local_w = pair / channels;
        const unsigned int c = pair - local_w * channels;
        int slot = -1;
        if (channels == 4U) {
            if (c == 0U) slot = 0;
            else if (c == 1U) slot = 1;
            else if (c == 2U) slot = 3;
            else if (c == 3U) slot = 4;
        } else if (channels == 5U) {
            if (c == 0U) slot = 0;
            else if (c == 1U) slot = 1;
            else if (c == 2U) slot = 2;
            else if (c == 3U) slot = 3;
            else if (c == 4U) slot = 4;
        } else {
            if (c == 0U) slot = 0;
            else if (c == 1U) slot = 1;
            else if (c == 2U) slot = 2;
            else if (c == 4U) slot = 3;
            else if (c == 5U) slot = 4;
        }
        if (slot < 0) continue;
        const unsigned int start = local_w * frames_per_window;
        if (start >= frames) continue;
        unsigned int end = start + frames_per_window;
        if (end > frames) end = frames;
        const unsigned int global_w = global_window_offset + local_w;
        const unsigned long long q_base = ((unsigned long long)global_w * channels + c) * 4ULL;
        double v1 = 0.0;
        double v2 = 0.0;
        double v3 = 0.0;
        double v4 = 0.0;
        for (unsigned int i = start; i < end; i++) {
            const double x = input[(unsigned long long)i * channels + c];
            const double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
            v4 = v3;
            v3 = v2;
            v2 = v1;
            v1 = v0;
        }
        q_states[q_base + 0ULL] = v1;
        q_states[q_base + 1ULL] = v2;
        q_states[q_base + 2ULL] = v3;
        q_states[q_base + 3ULL] = v4;
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
