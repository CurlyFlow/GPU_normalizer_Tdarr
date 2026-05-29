extern "C" __device__ double db_to_amp_dev(double db) {
    return pow(10.0, db / 20.0);
}

#define LOUDNORM_EXACT_GENERIC_LIMITER 0

extern "C" __device__ double energy_to_loudness_dev(double energy) {
    if (energy <= 0.0) return -1.0 / 0.0;
    return 10.0 * log10(energy) - 0.691;
}

extern "C" __device__ double kweight_v0_rn_dev(double x, const double *a, double v1, double v2, double v3, double v4) {
    double out = x;
    out = __dsub_rn(out, __dmul_rn(a[1], v1));
    out = __dsub_rn(out, __dmul_rn(a[2], v2));
    out = __dsub_rn(out, __dmul_rn(a[3], v3));
    out = __dsub_rn(out, __dmul_rn(a[4], v4));
    return out;
}

extern "C" __device__ double kweight_y_rn_dev(const double *b, double v0, double v1, double v2, double v3, double v4) {
    double out = __dmul_rn(b[0], v0);
    out = __dadd_rn(out, __dmul_rn(b[1], v1));
    out = __dadd_rn(out, __dmul_rn(b[2], v2));
    out = __dadd_rn(out, __dmul_rn(b[3], v3));
    out = __dadd_rn(out, __dmul_rn(b[4], v4));
    return out;
}

extern "C" __device__ double hist_energy_dev(int i) {
    return pow(10.0, (((double)i / 10.0) - 69.95 + 0.691) / 10.0);
}

extern "C" __device__ int hist_index_from_energy_dev(double energy) {
    double loud = energy_to_loudness_dev(energy);
    int idx = (int)floor((loud + 70.0) * 10.0);
    if (idx < 0) idx = 0;
    if (idx > 999) idx = 999;
    return idx;
}

extern "C" __device__ int hist_index_from_boundaries_dev(double energy, const double *boundaries) {
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

extern "C" __device__ double gated_loudness_dev(unsigned int *hist) {
    double total = 0.0;
    unsigned int count = 0;
    for (int i = 0; i < 1000; i++) {
        total += (double)hist[i] * hist_energy_dev(i);
        count += hist[i];
    }
    if (count == 0) return -1.0 / 0.0;
    double rel = (total / (double)count) * 0.1;
    int start = hist_index_from_energy_dev(rel);
    if (rel > hist_energy_dev(start) && start < 999) start++;
    double gated = 0.0;
    unsigned int gated_count = 0;
    for (int i = start; i < 1000; i++) {
        gated += (double)hist[i] * hist_energy_dev(i);
        gated_count += hist[i];
    }
    if (gated_count == 0) return -1.0 / 0.0;
    return energy_to_loudness_dev(gated / (double)gated_count);
}

extern "C" __device__ double gated_loudness_lut_dev(unsigned int *hist, const double *energies) {
    double total = 0.0;
    unsigned int count = 0;
    for (int i = 0; i < 1000; i++) {
        total += (double)hist[i] * energies[i];
        count += hist[i];
    }
    if (count == 0) return -1.0 / 0.0;
    double rel = (total / (double)count) * 0.1;
    int start = hist_index_from_energy_dev(rel);
    if (rel > energies[start] && start < 999) start++;
    double gated = 0.0;
    unsigned int gated_count = 0;
    for (int i = start; i < 1000; i++) {
        gated += (double)hist[i] * energies[i];
        gated_count += hist[i];
    }
    if (gated_count == 0) return -1.0 / 0.0;
    return energy_to_loudness_dev(gated / (double)gated_count);
}

extern "C" __device__ double gated_loudness_lut_boundaries_dev(unsigned int *hist, const double *energies, const double *boundaries) {
    double total = 0.0;
    unsigned int count = 0;
    for (int i = 0; i < 1000; i++) {
        total += (double)hist[i] * energies[i];
        count += hist[i];
    }
    if (count == 0) return -1.0 / 0.0;
    double rel = (total / (double)count) * 0.1;
    int start;
    if (rel < boundaries[0]) {
        start = 0;
    } else {
        start = hist_index_from_boundaries_dev(rel, boundaries);
        if (rel > energies[start] && start < 999) start++;
    }
    double gated = 0.0;
    unsigned int gated_count = 0;
    for (int i = start; i < 1000; i++) {
        gated += (double)hist[i] * energies[i];
        gated_count += hist[i];
    }
    if (gated_count == 0) return -1.0 / 0.0;
    return energy_to_loudness_dev(gated / (double)gated_count);
}

extern "C" __device__ double relative_threshold_dev(unsigned int *hist) {
    double total = 0.0;
    unsigned int count = 0;
    for (int i = 0; i < 1000; i++) {
        total += (double)hist[i] * hist_energy_dev(i);
        count += hist[i];
    }
    if (count == 0) return -70.0;
    return energy_to_loudness_dev((total / (double)count) * 0.1);
}

extern "C" __device__ double relative_threshold_lut_dev(unsigned int *hist, const double *energies) {
    double total = 0.0;
    unsigned int count = 0;
    for (int i = 0; i < 1000; i++) {
        total += (double)hist[i] * energies[i];
        count += hist[i];
    }
    if (count == 0) return -70.0;
    return energy_to_loudness_dev((total / (double)count) * 0.1);
}

extern "C" __device__ double gaussian_filter_dev(double *delta, const double *weights, int index) {
    double result = 0.0;
    index = index - 10 > 0 ? index - 10 : index + 20;
    for (int i = 0; i < 21; i++) {
        int j = index + i;
        if (j >= 30) j -= 30;
        result = __dadd_rn(result, __dmul_rn(delta[j], weights[i]));
    }
    return result;
}

extern "C" __device__ double ring_sum30_dev(const double *ring, int count, int next_index) {
    double sum = 0.0;
    if (count <= 0) return 0.0;
    if (count < 30) {
        for (int i = 0; i < count; i++) sum += ring[i];
        return sum;
    }
    int index = next_index;
    for (int i = 0; i < 30; i++) {
        sum += ring[index];
        index++;
        if (index >= 30) index = 0;
    }
    return sum;
}

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

extern "C" __global__ void window_peaks_f64_kernel(
    const double *input,
    unsigned int *peak_bits,
    unsigned int frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int global_frame_offset
) {
    const unsigned long long samples = (unsigned long long)frames * (unsigned long long)channels;
    const unsigned long long stride = (unsigned long long)blockDim.x * (unsigned long long)gridDim.x;
    for (unsigned long long idx = (unsigned long long)blockIdx.x * blockDim.x + threadIdx.x; idx < samples; idx += stride) {
        const unsigned int frame = (unsigned int)(idx / channels);
        const unsigned int global_w = (global_frame_offset + frame) / frames_per_window;
        const float ax = (float)fabs(input[idx]);
        if (ax > 0.0f) atomicMax(&peak_bits[global_w], __float_as_uint(ax));
    }
}

extern "C" __global__ void kweight_window_sums_f64_channel_offset_kernel(
    const double *input,
    double *channel_sums,
    unsigned int *peak_bits,
    double *states,
    double *source_start_states,
    unsigned int frames,
    unsigned int channels,
    unsigned int input_channels,
    unsigned int channel_offset,
    unsigned int frames_per_window,
    unsigned int global_frame_offset,
    const double *b,
    const double *a
) {
    const unsigned int c = blockIdx.x;
    if (c >= channels || channel_offset + c >= input_channels || threadIdx.x != 0) return;
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
    if (slot < 0) return;
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
            for (unsigned int i = start; i < end; i++) {
                const double x = input[((unsigned long long)i * input_channels) + channel_offset + c];
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
            channel_sums[((unsigned long long)current_w * channels) + c] = window_sum;
            current_w = w;
            window_sum = 0.0;
            if (source_start_states && channels == 2U) {
                const unsigned long long state_base = ((unsigned long long)current_w * channels + c) * 4ULL;
                source_start_states[state_base + 0] = v1;
                source_start_states[state_base + 1] = v2;
                source_start_states[state_base + 2] = v3;
                source_start_states[state_base + 3] = v4;
            }
        }
        const double x = input[((unsigned long long)i * input_channels) + channel_offset + c];
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
    if (frames > 0) channel_sums[((unsigned long long)current_w * channels) + c] = window_sum;
    states[c * 4 + 0] = v1;
    states[c * 4 + 1] = v2;
    states[c * 4 + 2] = v3;
    states[c * 4 + 3] = v4;
}

extern "C" __global__ void window_peaks_f64_offset_kernel(
    const double *input,
    unsigned int *peak_bits,
    unsigned int frames,
    unsigned int channels,
    unsigned int input_channels,
    unsigned int channel_offset,
    unsigned int frames_per_window,
    unsigned int global_frame_offset
) {
    if (channel_offset + channels > input_channels) return;
    const unsigned long long samples = (unsigned long long)frames * (unsigned long long)channels;
    const unsigned long long stride = (unsigned long long)blockDim.x * (unsigned long long)gridDim.x;
    for (unsigned long long idx = (unsigned long long)blockIdx.x * blockDim.x + threadIdx.x; idx < samples; idx += stride) {
        const unsigned int frame = (unsigned int)(idx / channels);
        const unsigned int c = (unsigned int)(idx - ((unsigned long long)frame * channels));
        const unsigned int global_w = (global_frame_offset + frame) / frames_per_window;
        const double x = input[((unsigned long long)frame * input_channels) + channel_offset + c];
        const float ax = (float)fabs(x);
        if (ax > 0.0f) atomicMax(&peak_bits[global_w], __float_as_uint(ax));
    }
}

extern "C" __global__ void compact_f64_channels_offset_kernel(
    const double *input,
    double *output,
    unsigned int frames,
    unsigned int channels,
    unsigned int input_channels,
    unsigned int channel_offset,
    unsigned int output_base_frame,
    unsigned int output_frames,
    unsigned int global_frame_offset
) {
    if (!input || !output || channels == 0U || channel_offset + channels > input_channels) return;
    const unsigned long long samples = (unsigned long long)frames * (unsigned long long)channels;
    const unsigned long long stride = (unsigned long long)blockDim.x * (unsigned long long)gridDim.x;
    for (unsigned long long idx = (unsigned long long)blockIdx.x * blockDim.x + threadIdx.x; idx < samples; idx += stride) {
        const unsigned int frame = (unsigned int)(idx / channels);
        const unsigned int c = (unsigned int)(idx - ((unsigned long long)frame * channels));
        const unsigned int global_frame = global_frame_offset + frame;
        if (global_frame < output_base_frame) continue;
        const unsigned int output_frame = global_frame - output_base_frame;
        if (output_frame >= output_frames) continue;
        output[((unsigned long long)output_frame * channels) + c] = input[((unsigned long long)frame * input_channels) + channel_offset + c];
    }
}

extern "C" __global__ void combine_channel_sums_kernel(
    const double *channel_sums,
    double *sums,
    unsigned int windows,
    unsigned int channels
) {
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int w = blockIdx.x * blockDim.x + threadIdx.x; w < windows; w += stride) {
        double s = 0.0;
        for (unsigned int c = 0; c < channels; c++) {
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
            if (slot >= 0) s += channel_sums[((unsigned long long)w * channels) + c];
        }
        sums[w] = s;
    }
}

extern "C" __device__ double source_window_range_sum_dev(
    const double *window_sums,
    const double *source_channel_sums,
    unsigned int start,
    unsigned int count,
    unsigned int channels,
    unsigned int windows,
    unsigned int source_faithful_stereo
) {
    if (start >= windows || count == 0U) return 0.0;
    unsigned int end = start + count;
    if (end > windows || end < start) end = windows;
    if (source_faithful_stereo && channels == 2U && source_channel_sums) {
        double total = 0.0;
        for (unsigned int c = 0; c < 2U; c++) {
            for (unsigned int w = start; w < end; w++) {
                total += source_channel_sums[((unsigned long long)w * 2ULL) + c];
            }
        }
        return total;
    }
    double total = 0.0;
    for (unsigned int w = start; w < end; w++) total += window_sums[w];
    return total;
}

extern "C" __global__ void source_port_gain_kernel(
    const double *window_sums,
    const unsigned int *peak_bits,
    float *gains,
    float *gains_next,
    unsigned int windows,
    unsigned int frames_per_window,
    float target_i,
    float target_lra,
    float target_tp,
    const double *hist_energies,
    const double *hist_boundaries,
    float measured_i_arg,
    float measured_thresh_arg,
    float offset_db,
    unsigned int linear_mode
) {
    if (blockIdx.x != 0 || threadIdx.x != 0) return;
    unsigned int hist[1000];
    for (int i = 0; i < 1000; i++) hist[i] = 0;
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
    const double measured_i = (double)measured_i_arg;
    const double measured_thresh = (double)measured_thresh_arg;
    const double offset_amp = db_to_amp_dev((double)offset_db);

    if (linear_mode != 0) {
        for (unsigned int i = 0; i < windows; i++) {
            gains[i] = (float)offset_amp;
            gains_next[i] = (float)offset_amp;
        }
        return;
    }

    for (unsigned int i = 0; i < windows; i++) {
        gains[i] = (float)offset_amp;
        gains_next[i] = (float)offset_amp;
    }
    const unsigned int first = windows < 30 ? windows : 30;
    for (unsigned int t = 0; t < first; t++) {
        if (short_count == 30) short_sum -= short_ring[short_index]; else short_count++;
        short_ring[short_index] = (double)window_sums[t];
        short_sum += (double)window_sums[t];
        short_index = (short_index + 1) % 30;
        if (t >= 3) {
            double e = ((double)window_sums[t] + (double)window_sums[t - 1] + (double)window_sums[t - 2] + (double)window_sums[t - 3]) / (double)(frames_per_window * 4);
            if (e >= hist_boundaries[0]) hist[hist_index_from_boundaries_dev(e, hist_boundaries)]++;
        }
    }

    double shortterm = short_count > 0 ? energy_to_loudness_dev(short_sum / (double)(frames_per_window * 30)) : -1.0 / 0.0;
    double env_shortterm;
    if (shortterm < measured_thresh) {
        above_threshold = 0;
        env_shortterm = shortterm <= -70.0 ? 0.0 : (double)target_i - measured_i;
    } else {
        above_threshold = 1;
        env_shortterm = shortterm <= -70.0 ? 0.0 : (double)target_i - shortterm;
    }
    double init_gain = db_to_amp_dev(env_shortterm);
    for (int i = 0; i < 30; i++) delta[i] = init_gain;
    prev_delta = delta[index];
    if (windows > 0) {
        gains[0] = (float)(delta[index] * offset_amp);
        gains_next[0] = gains[0];
        out_short_ring[out_short_index] = (double)window_sums[0] * (double)gains[0] * (double)gains[0];
        out_short_sum += out_short_ring[out_short_index];
        out_short_index = (out_short_index + 1) % 30;
        out_short_count = 1;
    }

    unsigned int out_idx = 1;
    for (unsigned int t = 30; t < windows; t++) {
        double gain = gaussian_filter_dev(delta, weights, (index + 10) < 30 ? (index + 10) : (index + 10 - 30));
        double next_gain = gaussian_filter_dev(delta, weights, (index + 11) < 30 ? (index + 11) : (index + 11 - 30));
        if (out_idx < windows) {
            const double effective_gain = gain * offset_amp;
            const double effective_next_gain = next_gain * offset_amp;
            gains[out_idx] = (float)effective_gain;
            gains_next[out_idx] = (float)effective_next_gain;
            if (out_short_count == 30) out_short_sum -= out_short_ring[out_short_index]; else out_short_count++;
            out_short_ring[out_short_index] = (double)window_sums[out_idx] * effective_gain * effective_gain;
            out_short_sum += out_short_ring[out_short_index];
            out_short_index = (out_short_index + 1) % 30;
            out_idx++;
        }

        if (short_count == 30) short_sum -= short_ring[short_index]; else short_count++;
        short_ring[short_index] = (double)window_sums[t];
        short_sum += (double)window_sums[t];
        short_index = (short_index + 1) % 30;
        double e = ((double)window_sums[t] + (double)window_sums[t - 1] + (double)window_sums[t - 2] + (double)window_sums[t - 3]) / (double)(frames_per_window * 4);
        if (e >= hist_boundaries[0]) hist[hist_index_from_boundaries_dev(e, hist_boundaries)]++;

        const double global = gated_loudness_lut_boundaries_dev(hist, hist_energies, hist_boundaries);
        shortterm = energy_to_loudness_dev(short_sum / (double)(frames_per_window * 30));
        const double relative_threshold = relative_threshold_lut_dev(hist, hist_energies);
        if (above_threshold == 0) {
            double shortterm_out = energy_to_loudness_dev(out_short_sum / (double)(frames_per_window * 30));
            if (shortterm > measured_thresh) prev_delta *= 1.0058;
            if (shortterm_out >= target_i) above_threshold = 1;
        }
        if (shortterm < relative_threshold || shortterm <= -70.0 || above_threshold == 0) {
            delta[index] = prev_delta;
        } else {
            double diff = isfinite(global) ? (shortterm - global) : 0.0;
            double limit = (double)target_lra / 2.0;
            double env_global = fabs(diff) < limit ? diff : (diff < 0.0 ? -limit : limit);
            env_shortterm = (double)target_i - shortterm;
            delta[index] = db_to_amp_dev(env_global + env_shortterm);
        }
        prev_delta = delta[index];
        index++;
        if (index >= 30) index -= 30;
    }
    double final_gain = gaussian_filter_dev(delta, weights, (index + 10) < 30 ? (index + 10) : (index + 10 - 30));
    while (out_idx < windows) {
        gains[out_idx] = (float)(final_gain * offset_amp);
        gains_next[out_idx] = gains[out_idx];
        out_idx++;
    }

    for (unsigned int i = 0; i < windows; i++) {
        if (gains[i] < 0.0f) gains[i] = 0.0f;
        if (gains_next[i] < 0.0f) gains_next[i] = 0.0f;
    }
}

extern "C" __global__ void source_port_metrics_kernel(
    const double *window_sums,
    const float *gains,
    float *metrics,
    unsigned int windows,
    unsigned int frames_per_window,
    const double *hist_energies,
    const double *hist_boundaries
) {
    if (blockIdx.x != 0 || threadIdx.x != 0) return;
    unsigned int hist[1000];
    for (int i = 0; i < 1000; i++) hist[i] = 0;

    for (unsigned int t = 3; t < windows; t++) {
        double energy = ((double)window_sums[t] + (double)window_sums[t - 1] + (double)window_sums[t - 2] + (double)window_sums[t - 3]) / (double)(frames_per_window * 4);
        if (energy >= hist_boundaries[0]) {
            hist[hist_index_from_boundaries_dev(energy, hist_boundaries)]++;
        }
    }

    double input_i = gated_loudness_lut_boundaries_dev(hist, hist_energies, hist_boundaries);
    float gain_min = windows > 0 ? gains[0] : 1.0f;
    float gain_max = windows > 0 ? gains[0] : 1.0f;
    for (unsigned int i = 1; i < windows; i++) {
        float g = gains[i];
        if (g < gain_min) gain_min = g;
        if (g > gain_max) gain_max = g;
    }
    metrics[0] = (float)input_i;
    metrics[1] = gain_min;
    metrics[2] = gain_max;
}

extern "C" __global__ void apply_plan_kernel(
    const float *input,
    float *output,
    const float *gains,
    unsigned int samples,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    unsigned int global_frame_offset,
    float ceiling
) {
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    unsigned int stride = blockDim.x * gridDim.x;
    for (; idx < samples; idx += stride) {
        unsigned int frame = global_frame_offset + (idx / channels);
        unsigned int w0 = frame / frames_per_window;
        unsigned int pos = frame - (w0 * frames_per_window);
        unsigned int w1 = w0 + 1;
        if (w1 >= windows) w1 = windows - 1;
        float a = (float)pos / (float)frames_per_window;
        float g = gains[w0] + (gains[w1] - gains[w0]) * a;
        float v = input[idx] * g;
        if (v > ceiling) v = ceiling;
        if (v < -ceiling) v = -ceiling;
        output[idx] = v;
    }
}

extern "C" __global__ void apply_plan_f64_kernel(
    const float *input,
    double *output,
    const float *gains,
    unsigned int samples,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    unsigned int global_frame_offset,
    float ceiling
) {
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    unsigned int stride = blockDim.x * gridDim.x;
    for (; idx < samples; idx += stride) {
        unsigned int frame = global_frame_offset + (idx / channels);
        unsigned int w0 = frame / frames_per_window;
        unsigned int pos = frame - (w0 * frames_per_window);
        unsigned int w1 = w0 + 1;
        if (w1 >= windows) w1 = windows - 1;
        double a = (double)pos / (double)frames_per_window;
        double g0 = (double)gains[w0];
        double g1 = (double)gains[w1];
        double g = g0 + (g1 - g0) * a;
        double v = (double)input[idx] * g;
        double limit = (double)ceiling;
        if (v > limit) v = limit;
        if (v < -limit) v = -limit;
        output[idx] = v;
    }
}

extern "C" __global__ void apply_plan_f64_io_kernel(
    const double *input,
    double *output,
    const float *gains,
    unsigned int samples,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    unsigned int global_frame_offset,
    float ceiling
) {
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    unsigned int stride = blockDim.x * gridDim.x;
    for (; idx < samples; idx += stride) {
        unsigned int frame = global_frame_offset + (idx / channels);
        unsigned int w0 = frame / frames_per_window;
        unsigned int pos = frame - (w0 * frames_per_window);
        unsigned int w1 = w0 + 1;
        if (w1 >= windows) w1 = windows - 1;
        double a = (double)pos / (double)frames_per_window;
        double g0 = (double)gains[w0];
        double g1 = (double)gains[w1];
        double g = g0 + (g1 - g0) * a;
        double v = input[idx] * g;
        double limit = (double)ceiling;
        if (v > limit) v = limit;
        if (v < -limit) v = -limit;
        output[idx] = v;
    }
}

extern "C" __global__ void apply_linear_f64_io_kernel(
    const double *input,
    double *output,
    double gain,
    unsigned int samples,
    float ceiling
) {
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    unsigned int stride = blockDim.x * gridDim.x;
    for (; idx < samples; idx += stride) {
        double v = input[idx] * gain;
        double limit = (double)ceiling;
        if (v > limit) v = limit;
        if (v < -limit) v = -limit;
        output[idx] = v;
    }
}

extern "C" __global__ void apply_plan_f64_io_ffmpeg_timing_kernel(
    const double *input,
    double *output,
    const float *gains,
    const float *gains_next,
    unsigned int samples,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    unsigned int global_frame_offset,
    unsigned int limiter_lookahead_frames,
    unsigned int gain_timing_offset_frames,
    float ceiling
) {
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    unsigned int stride = blockDim.x * gridDim.x;
    for (; idx < samples; idx += stride) {
        unsigned int frame = global_frame_offset + (idx / channels);
        double g;
        if (frame < gain_timing_offset_frames || windows <= 1) {
            g = (double)gains[0];
        } else {
            unsigned int shifted = frame - gain_timing_offset_frames;
            unsigned int seg = (shifted / frames_per_window) + 1;
            unsigned int pos = shifted - ((seg - 1) * frames_per_window);
            if (seg >= windows) seg = windows - 1;
            double a = (double)pos / (double)frames_per_window;
            double g0 = (double)gains[seg];
            double g1 = (double)gains_next[seg];
            g = g0 + (g1 - g0) * a;
        }
        double v = input[idx] * g;
        double limit = (double)ceiling;
        if (v > limit) v = limit;
        if (v < -limit) v = -limit;
        output[idx] = v;
    }
}

extern "C" __device__ double ffmpeg_timed_gain_dev(
    const float *gains,
    const float *gains_next,
    unsigned int frame,
    unsigned int frames_per_window,
    unsigned int windows,
    unsigned int limiter_lookahead_frames,
    unsigned int gain_timing_offset_frames
);

extern "C" __global__ void apply_plan_f64_io_ffmpeg_timing_final_kernel(
    const double *input,
    double *output,
    const float *gains,
    const float *gains_next,
    unsigned int samples,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    unsigned int global_frame_offset,
    unsigned int limiter_lookahead_frames,
    unsigned int gain_timing_offset_frames,
    unsigned int total_frames,
    float ceiling
) {
    const unsigned int first_frame_length = frames_per_window * 30U;
    const unsigned int final_flush_frames = first_frame_length > frames_per_window ? first_frame_length - frames_per_window : 0U;
    const int use_final_flush = total_frames > first_frame_length && final_flush_frames > 0U && total_frames > final_flush_frames;
    const unsigned int prefinal_frames = use_final_flush ? total_frames - final_flush_frames : total_frames;
    const double final_gain = windows > 0U ? (double)gains[windows - 1U] : 1.0;
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    unsigned int stride = blockDim.x * gridDim.x;
    for (; idx < samples; idx += stride) {
        unsigned int frame = global_frame_offset + (idx / channels);
        double g = (use_final_flush && frame >= prefinal_frames)
            ? final_gain
            : ffmpeg_timed_gain_dev(gains, gains_next, frame, frames_per_window, windows, limiter_lookahead_frames, gain_timing_offset_frames);
        double v = input[idx] * g;
        double limit = (double)ceiling;
        if (v > limit) v = limit;
        if (v < -limit) v = -limit;
        output[idx] = v;
    }
}

extern "C" __global__ void apply_plan_f64_io_ffmpeg_timing_final_window_kernel(
    const double *input,
    double *output,
    const float *gains,
    const float *gains_next,
    unsigned int samples,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    unsigned int output_frame_offset,
    unsigned int input_base_frame,
    unsigned int limiter_lookahead_frames,
    unsigned int gain_timing_offset_frames,
    unsigned int total_frames,
    float ceiling
) {
    const unsigned int first_frame_length = frames_per_window * 30U;
    const unsigned int final_flush_frames = first_frame_length > frames_per_window ? first_frame_length - frames_per_window : 0U;
    const int use_final_flush = total_frames > first_frame_length && final_flush_frames > 0U && total_frames > final_flush_frames;
    const unsigned int prefinal_frames = use_final_flush ? total_frames - final_flush_frames : total_frames;
    const double final_gain = windows > 0U ? (double)gains[windows - 1U] : 1.0;
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    unsigned int stride = blockDim.x * gridDim.x;
    for (; idx < samples; idx += stride) {
        unsigned int frame = output_frame_offset + (idx / channels);
        unsigned int c = idx % channels;
        double g = (use_final_flush && frame >= prefinal_frames)
            ? final_gain
            : ffmpeg_timed_gain_dev(gains, gains_next, frame, frames_per_window, windows, limiter_lookahead_frames, gain_timing_offset_frames);
        unsigned int local_frame = frame >= input_base_frame ? frame - input_base_frame : 0U;
        double v = input[((unsigned long long)local_frame * channels) + c] * g;
        double limit = (double)ceiling;
        if (v > limit) v = limit;
        if (v < -limit) v = -limit;
        output[idx] = v;
    }
}

extern "C" __device__ double ffmpeg_timed_gain_dev(
    const float *gains,
    const float *gains_next,
    unsigned int frame,
    unsigned int frames_per_window,
    unsigned int windows,
    unsigned int limiter_lookahead_frames,
    unsigned int gain_timing_offset_frames
) {
    if (frame < gain_timing_offset_frames || windows <= 1) return (double)gains[0];
    unsigned int shifted = frame - gain_timing_offset_frames;
    unsigned int seg = (shifted / frames_per_window) + 1;
    unsigned int pos = shifted - ((seg - 1) * frames_per_window);
    if (seg >= windows) seg = windows - 1;
    double a = (double)pos / (double)frames_per_window;
    double g0 = (double)gains[seg];
    double g1 = (double)gains_next[seg];
    return g0 + (g1 - g0) * a;
}

extern "C" __device__ unsigned int wrap_sample_index_dev(int index, unsigned int size) {
    while (index < 0) index += (int)size;
    while ((unsigned int)index >= size) index -= (int)size;
    return (unsigned int)index;
}

#define FB_D_COUNT_OUTPUT_FRAMES 116
#define FB_D_COUNT_INPUT_READS 117
#define FB_D_COUNT_INPUT_ZEROS 118
#define FB_D_COUNT_LIMITER_WRITES 119
#define FB_D_COUNT_LIMITER_RW_SCALES 120
#define FB_D_COUNT_OUTPUT_WRITES 121
#define FB_D_COUNT_FEEDBACK_IIR 122
#define FB_D_COUNT_SHORT_RING_WRITES 123
#define FB_D_COUNT_DETECT_CALLS 124
#define FB_D_COUNT_DETECT_FRAMES 125
#define FB_D_COUNT_DETECT_LOOKAHEAD 126
#define FB_D_COUNT_PEAK_HITS 127

extern "C" __device__ void detect_peak_6_dev(
    double *buf,
    int limiter_buf_size,
    int limiter_buf_index,
    int offset,
    int nb_samples,
    int attack_length,
    double ceiling,
    int frame_type,
    double *prev_smp,
    int *peak_delta,
    double *peak_value,
    int *peak_index,
    double *profile_counts
) {
    *peak_delta = -1;
    if (profile_counts) profile_counts[FB_D_COUNT_DETECT_CALLS] += 1.0;
    int index = limiter_buf_index + (offset * 6) + (attack_length * 6);
    if (index >= limiter_buf_size) index -= limiter_buf_size;

    if (frame_type == 0) {
        prev_smp[0] = fabs(buf[index - 6]);
        prev_smp[1] = fabs(buf[index - 5]);
        prev_smp[2] = fabs(buf[index - 4]);
        prev_smp[3] = fabs(buf[index - 3]);
        prev_smp[4] = fabs(buf[index - 2]);
        prev_smp[5] = fabs(buf[index - 1]);
    }

#define DETECT_PEAK6_CHECK(C, THIS_S, NEXT_S) \
    do { \
        int skip_update = 0; \
        if ((prev_smp[C] <= (THIS_S)) && ((NEXT_S) <= (THIS_S)) && ((THIS_S) > ceiling) && (n > 0)) { \
            int detected = 1; \
            for (int i = 2; i < 12; i++) { \
                if (profile_counts) profile_counts[FB_D_COUNT_DETECT_LOOKAHEAD] += 1.0; \
                int lookahead_index = index + C + (i * 6); \
                if (lookahead_index >= limiter_buf_size) lookahead_index -= limiter_buf_size; \
                double next = fabs(buf[lookahead_index]); \
                if (next > (THIS_S)) { \
                    detected = 0; \
                    break; \
                } \
            } \
            if (!detected) { \
                skip_update = 1; \
            } else { \
                double max_peak = t0; \
                if (t1 > max_peak) max_peak = t1; \
                if (t2 > max_peak) max_peak = t2; \
                if (t3 > max_peak) max_peak = t3; \
                if (t4 > max_peak) max_peak = t4; \
                if (t5 > max_peak) max_peak = t5; \
                prev_smp[0] = t0; \
                prev_smp[1] = t1; \
                prev_smp[2] = t2; \
                prev_smp[3] = t3; \
                prev_smp[4] = t4; \
                prev_smp[5] = t5; \
                *peak_delta = n; \
                *peak_index = index; \
                *peak_value = max_peak; \
                if (profile_counts) profile_counts[FB_D_COUNT_PEAK_HITS] += 1.0; \
                return; \
            } \
        } \
        if (!skip_update) prev_smp[C] = (THIS_S); \
    } while (0)

    for (int n = 0; n < nb_samples; n++) {
        if (profile_counts) profile_counts[FB_D_COUNT_DETECT_FRAMES] += 1.0;
        const double t0 = fabs(buf[index + 0]);
        const double t1 = fabs(buf[index + 1]);
        const double t2 = fabs(buf[index + 2]);
        const double t3 = fabs(buf[index + 3]);
        const double t4 = fabs(buf[index + 4]);
        const double t5 = fabs(buf[index + 5]);
        double frame_peak = t0;
        if (t1 > frame_peak) frame_peak = t1;
        if (t2 > frame_peak) frame_peak = t2;
        if (t3 > frame_peak) frame_peak = t3;
        if (t4 > frame_peak) frame_peak = t4;
        if (t5 > frame_peak) frame_peak = t5;
        if (n == 0 || frame_peak <= ceiling) {
            prev_smp[0] = t0;
            prev_smp[1] = t1;
            prev_smp[2] = t2;
            prev_smp[3] = t3;
            prev_smp[4] = t4;
            prev_smp[5] = t5;
            index += 6;
            if (index >= limiter_buf_size) index -= limiter_buf_size;
            continue;
        }
        int next_index = index + 6;
        if (next_index >= limiter_buf_size) next_index -= limiter_buf_size;
        const double n0 = fabs(buf[next_index + 0]);
        const double n1 = fabs(buf[next_index + 1]);
        const double n2 = fabs(buf[next_index + 2]);
        const double n3 = fabs(buf[next_index + 3]);
        const double n4 = fabs(buf[next_index + 4]);
        const double n5 = fabs(buf[next_index + 5]);

        DETECT_PEAK6_CHECK(0, t0, n0);
        DETECT_PEAK6_CHECK(1, t1, n1);
        DETECT_PEAK6_CHECK(2, t2, n2);
        DETECT_PEAK6_CHECK(3, t3, n3);
        DETECT_PEAK6_CHECK(4, t4, n4);
        DETECT_PEAK6_CHECK(5, t5, n5);

        index += 6;
        if (index >= limiter_buf_size) index -= limiter_buf_size;
    }

#undef DETECT_PEAK6_CHECK
}

extern "C" __device__ void detect_peak_2_dev(
    double *buf,
    int limiter_buf_size,
    int limiter_buf_index,
    int offset,
    int nb_samples,
    int attack_length,
    double ceiling,
    int frame_type,
    double *prev_smp,
    int *peak_delta,
    double *peak_value,
    int *peak_index,
    double *profile_counts
) {
    *peak_delta = -1;
    if (profile_counts) profile_counts[FB_D_COUNT_DETECT_CALLS] += 1.0;
    int index = limiter_buf_index + (offset * 2) + (attack_length * 2);
    if (index >= limiter_buf_size) index -= limiter_buf_size;

    if (frame_type == 0) {
        prev_smp[0] = fabs(buf[index - 2]);
        prev_smp[1] = fabs(buf[index - 1]);
    }

#define DETECT_PEAK2_CHECK(C, THIS_S, NEXT_S) \
    do { \
        int skip_update = 0; \
        if ((prev_smp[C] <= (THIS_S)) && ((NEXT_S) <= (THIS_S)) && ((THIS_S) > ceiling) && (n > 0)) { \
            int detected = 1; \
            for (int i = 2; i < 12; i++) { \
                if (profile_counts) profile_counts[FB_D_COUNT_DETECT_LOOKAHEAD] += 1.0; \
                int lookahead_index = index + C + (i * 2); \
                if (lookahead_index >= limiter_buf_size) lookahead_index -= limiter_buf_size; \
                double next = fabs(buf[lookahead_index]); \
                if (next > (THIS_S)) { \
                    detected = 0; \
                    break; \
                } \
            } \
            if (!detected) { \
                skip_update = 1; \
            } else { \
                double max_peak = t0; \
                if (t1 > max_peak) max_peak = t1; \
                prev_smp[0] = t0; \
                prev_smp[1] = t1; \
                *peak_delta = n; \
                *peak_index = index; \
                *peak_value = max_peak; \
                if (profile_counts) profile_counts[FB_D_COUNT_PEAK_HITS] += 1.0; \
                return; \
            } \
        } \
        if (!skip_update) prev_smp[C] = (THIS_S); \
    } while (0)

    for (int n = 0; n < nb_samples; n++) {
        if (profile_counts) profile_counts[FB_D_COUNT_DETECT_FRAMES] += 1.0;
        const double t0 = fabs(buf[index + 0]);
        const double t1 = fabs(buf[index + 1]);
        const double frame_peak = t0 > t1 ? t0 : t1;
        if (n == 0 || frame_peak <= ceiling) {
            prev_smp[0] = t0;
            prev_smp[1] = t1;
            index += 2;
            if (index >= limiter_buf_size) index -= limiter_buf_size;
            continue;
        }
        int next_index = index + 2;
        if (next_index >= limiter_buf_size) next_index -= limiter_buf_size;
        const double n0 = fabs(buf[next_index + 0]);
        const double n1 = fabs(buf[next_index + 1]);

        DETECT_PEAK2_CHECK(0, t0, n0);
        DETECT_PEAK2_CHECK(1, t1, n1);

        index += 2;
        if (index >= limiter_buf_size) index -= limiter_buf_size;
    }

#undef DETECT_PEAK2_CHECK
}

extern "C" __device__ void detect_peak_dev(
    double *buf,
    int limiter_buf_size,
    int limiter_buf_index,
    int offset,
    int nb_samples,
    int channels,
    int attack_length,
    double ceiling,
    int frame_type,
    double *prev_smp,
    int *peak_delta,
    double *peak_value,
    int *peak_index,
    double *profile_counts
) {
#if !LOUDNORM_EXACT_GENERIC_LIMITER
    if (channels == 6) {
        detect_peak_6_dev(buf, limiter_buf_size, limiter_buf_index, offset, nb_samples, attack_length, ceiling, frame_type, prev_smp, peak_delta, peak_value, peak_index, profile_counts);
        return;
    }
    if (channels == 2) {
        detect_peak_2_dev(buf, limiter_buf_size, limiter_buf_index, offset, nb_samples, attack_length, ceiling, frame_type, prev_smp, peak_delta, peak_value, peak_index, profile_counts);
        return;
    }
#endif
    *peak_delta = -1;
    if (profile_counts) profile_counts[FB_D_COUNT_DETECT_CALLS] += 1.0;
    int index = limiter_buf_index + (offset * channels) + (attack_length * channels);
    if (index >= limiter_buf_size) index -= limiter_buf_size;

    if (frame_type == 0) {
        for (int c = 0; c < channels; c++) {
            prev_smp[c] = fabs(buf[index + c - channels]);
        }
    }

    for (int n = 0; n < nb_samples; n++) {
        if (profile_counts) profile_counts[FB_D_COUNT_DETECT_FRAMES] += 1.0;
        for (int c = 0; c < channels; c++) {
            int this_index = index + c;
            if (this_index >= limiter_buf_size) this_index -= limiter_buf_size;
            double this_s = fabs(buf[this_index]);
            int next_index = index + c + channels;
            if (next_index >= limiter_buf_size) next_index -= limiter_buf_size;
            double next = fabs(buf[next_index]);
            if ((prev_smp[c] <= this_s) && (next <= this_s) && (this_s > ceiling) && (n > 0)) {
                int detected = 1;
                for (int i = 2; i < 12; i++) {
                    if (profile_counts) profile_counts[FB_D_COUNT_DETECT_LOOKAHEAD] += 1.0;
                    int lookahead_index = index + c + (i * channels);
                    if (lookahead_index >= limiter_buf_size) lookahead_index -= limiter_buf_size;
                    next = fabs(buf[lookahead_index]);
                    if (next > this_s) {
                        detected = 0;
                        break;
                    }
                }
                if (!detected) continue;
                double max_peak = 0.0;
                for (int cc = 0; cc < channels; cc++) {
                    if (cc == 0 || fabs(buf[index + cc]) > max_peak) max_peak = fabs(buf[index + cc]);
                    int prev_index = index + cc;
                    if (prev_index >= limiter_buf_size) prev_index -= limiter_buf_size;
                    prev_smp[cc] = fabs(buf[prev_index]);
                }
                *peak_delta = n;
                *peak_index = index;
                *peak_value = max_peak;
                if (profile_counts) profile_counts[FB_D_COUNT_PEAK_HITS] += 1.0;
                return;
            }
            prev_smp[c] = this_s;
        }
        index += channels;
        if (index >= limiter_buf_size) index -= limiter_buf_size;
    }
}

extern "C" __device__ void add_feedback_output_dev(
    const double *output,
    unsigned int output_frame_offset,
    unsigned int nb_samples,
    unsigned int channels,
    unsigned int frames_per_window,
    const double *b,
    const double *a,
    double *out_states,
    double *out_short_ring,
    double *out_short_sum,
    int *out_short_index,
    int *out_short_count,
    double *out_window_sum,
    unsigned int *out_window_count
);

extern "C" __device__ double source_stereo_recompute_short_sum_dev(
    const double *ring0,
    const double *ring1
) {
    double sum0 = 0.0;
    double sum1 = 0.0;
    for (int i = 0; i < 30; i++) sum0 += ring0[i];
    for (int i = 0; i < 30; i++) sum1 += ring1[i];
    return sum0 + sum1;
}

extern "C" __device__ void true_peak_limiter_dev(
    double *limiter_buf,
    double *output,
    unsigned int output_frame_offset,
    unsigned int nb_samples,
    unsigned int channels,
    unsigned int limiter_buf_size,
    unsigned int limiter_buf_index,
    unsigned int attack_length,
    unsigned int release_length,
    double ceiling,
    int frame_type,
    double *prev_smp,
    int *limiter_state,
    int *peak_index,
    int *env_index,
    int *env_cnt,
    int *attack_state,
    double *gain_reduction0,
    double *gain_reduction1,
    int feedback_enabled,
    unsigned int frames_per_window,
    const double *b,
    const double *a,
    double *out_states,
    double *out_short_ring,
    double *out_short_sum,
    int *out_short_index,
    int *out_short_count,
    double *out_window_sum,
    unsigned int *out_window_count,
    double *profile_counts,
    int limiter_maybe_above_ceiling,
    int output_enabled,
    unsigned int source_faithful_stereo,
    double *source_out_short_ring0,
    double *source_out_short_ring1,
    double *source_out_window_sum0,
    double *source_out_window_sum1
) {
    int index = (int)limiter_buf_index;
    int smp_cnt = 0;
    double prev_smp_local[16];
    double *prev_smp_work = prev_smp;
    if (channels <= 16U) {
        for (unsigned int c = 0; c < channels; c++) prev_smp_local[c] = prev_smp[c];
        prev_smp_work = prev_smp_local;
    }
    double out_states_local[20];
    double *out_states_work = out_states;
    if (feedback_enabled) {
        for (int i = 0; i < 20; i++) out_states_local[i] = out_states[i];
        out_states_work = out_states_local;
    }
    int limiter_state_work = *limiter_state;
    int peak_index_work = *peak_index;
    int env_index_work = *env_index;
    int env_cnt_work = *env_cnt;
    int attack_state_work = *attack_state;
    double gain_reduction0_work = *gain_reduction0;
    double gain_reduction1_work = *gain_reduction1;
    if (profile_counts) profile_counts[FB_D_COUNT_OUTPUT_FRAMES] += (double)nb_samples;

    if (frame_type == 0) {
        double max_v = 0.0;
        for (int n = 0; n < (int)attack_length; n++) {
            for (int c = 0; c < (int)channels; c++) {
                double v = fabs(limiter_buf[n * (int)channels + c]);
                if (v > max_v) max_v = v;
            }
        }
        if (max_v > ceiling) {
            gain_reduction1_work = __ddiv_rn(ceiling, max_v);
            limiter_state_work = 2;
            for (int n = 0; n < (int)attack_length; n++) {
                for (int c = 0; c < (int)channels; c++) {
                    limiter_buf[n * (int)channels + c] = __dmul_rn(limiter_buf[n * (int)channels + c], gain_reduction1_work);
                    if (profile_counts) profile_counts[FB_D_COUNT_LIMITER_RW_SCALES] += 1.0;
                }
            }
        }
    }

    const int skip_peak_detection = !LOUDNORM_EXACT_GENERIC_LIMITER && (channels == 6U || channels == 2U) && limiter_state_work == 0 && limiter_maybe_above_ceiling <= 0;
    if (skip_peak_detection) {
        int scan_index = (int)limiter_buf_index + ((int)attack_length * (int)channels);
        while (scan_index >= (int)limiter_buf_size) scan_index -= (int)limiter_buf_size;
        if (nb_samples > 0U) {
            int last_index = scan_index + (((int)nb_samples - 1) * (int)channels);
            while (last_index >= (int)limiter_buf_size) last_index -= (int)limiter_buf_size;
            for (int c = 0; c < (int)channels; c++) {
                prev_smp_work[c] = fabs(limiter_buf[last_index + c]);
            }
        }
    } else do {
        if (limiter_state_work == 0) {
            int peak_delta;
            double peak_value;
            detect_peak_dev(limiter_buf, (int)limiter_buf_size, (int)limiter_buf_index, smp_cnt, (int)nb_samples - smp_cnt, (int)channels, attack_state_work, ceiling, frame_type, prev_smp_work, &peak_delta, &peak_value, &peak_index_work, profile_counts);
            if (peak_delta != -1) {
                env_cnt_work = 0;
                smp_cnt += peak_delta - attack_state_work;
                gain_reduction0_work = 1.0;
                gain_reduction1_work = __ddiv_rn(ceiling, peak_value);
                limiter_state_work = 1;
                env_index_work = peak_index_work - (attack_state_work * (int)channels);
                if (env_index_work < 0) env_index_work += (int)limiter_buf_size;
                env_index_work += (env_cnt_work * (int)channels);
                if (env_index_work > (int)limiter_buf_size) env_index_work -= (int)limiter_buf_size;
            } else {
                smp_cnt = (int)nb_samples;
            }
        } else if (limiter_state_work == 1) {
            for (; env_cnt_work < attack_state_work; env_cnt_work++) {
                for (int c = 0; c < (int)channels; c++) {
                    double env_frac = __ddiv_rn((double)env_cnt_work, (double)(attack_state_work - 1));
                    double env_delta = __dsub_rn(gain_reduction0_work, gain_reduction1_work);
                    double env = __dsub_rn(gain_reduction0_work, __dmul_rn(env_frac, env_delta));
                    limiter_buf[env_index_work + c] = __dmul_rn(limiter_buf[env_index_work + c], env);
                    if (profile_counts) profile_counts[FB_D_COUNT_LIMITER_RW_SCALES] += 1.0;
                }
                env_index_work += (int)channels;
                if (env_index_work >= (int)limiter_buf_size) env_index_work -= (int)limiter_buf_size;
                smp_cnt++;
                if (smp_cnt >= (int)nb_samples) {
                    env_cnt_work++;
                    break;
                }
            }
            if (smp_cnt < (int)nb_samples) {
                env_cnt_work = 0;
                attack_state_work = (int)attack_length;
                limiter_state_work = 2;
            }
        } else if (limiter_state_work == 2) {
            int peak_delta;
            double peak_value;
            detect_peak_dev(limiter_buf, (int)limiter_buf_size, (int)limiter_buf_index, smp_cnt, (int)nb_samples, (int)channels, attack_state_work, ceiling, frame_type, prev_smp_work, &peak_delta, &peak_value, &peak_index_work, profile_counts);
            if (peak_delta == -1) {
                limiter_state_work = 3;
                gain_reduction0_work = gain_reduction1_work;
                gain_reduction1_work = 1.0;
                env_cnt_work = 0;
            } else {
                double gain_reduction = __ddiv_rn(ceiling, peak_value);
                if (gain_reduction < gain_reduction1_work) {
                    limiter_state_work = 1;
                    attack_state_work = peak_delta;
                    if (attack_state_work <= 1) attack_state_work = 2;
                    gain_reduction0_work = gain_reduction1_work;
                    gain_reduction1_work = gain_reduction;
                    env_cnt_work = 0;
                } else {
                    for (env_cnt_work = 0; env_cnt_work < peak_delta; env_cnt_work++) {
                        for (int c = 0; c < (int)channels; c++) {
                            limiter_buf[env_index_work + c] = __dmul_rn(limiter_buf[env_index_work + c], gain_reduction1_work);
                            if (profile_counts) profile_counts[FB_D_COUNT_LIMITER_RW_SCALES] += 1.0;
                        }
                        env_index_work += (int)channels;
                        if (env_index_work >= (int)limiter_buf_size) env_index_work -= (int)limiter_buf_size;
                        smp_cnt++;
                        if (smp_cnt >= (int)nb_samples) {
                            env_cnt_work++;
                            break;
                        }
                    }
                }
            }
        } else {
            for (; env_cnt_work < (int)release_length; env_cnt_work++) {
                for (int c = 0; c < (int)channels; c++) {
                    double env_frac = __ddiv_rn((double)env_cnt_work, (double)(release_length - 1));
                    double env_delta = __dsub_rn(gain_reduction1_work, gain_reduction0_work);
                    double env = __dadd_rn(gain_reduction0_work, __dmul_rn(env_frac, env_delta));
                    limiter_buf[env_index_work + c] = __dmul_rn(limiter_buf[env_index_work + c], env);
                    if (profile_counts) profile_counts[FB_D_COUNT_LIMITER_RW_SCALES] += 1.0;
                }
                env_index_work += (int)channels;
                if (env_index_work >= (int)limiter_buf_size) env_index_work -= (int)limiter_buf_size;
                smp_cnt++;
                if (smp_cnt >= (int)nb_samples) {
                    env_cnt_work++;
                    break;
                }
            }
            if (smp_cnt < (int)nb_samples) {
                env_cnt_work = 0;
                limiter_state_work = 0;
            }
        }
    } while (smp_cnt < (int)nb_samples);

    *limiter_state = limiter_state_work;
    *peak_index = peak_index_work;
    *env_index = env_index_work;
    *env_cnt = env_cnt_work;
    *attack_state = attack_state_work;
    *gain_reduction0 = gain_reduction0_work;
    *gain_reduction1 = gain_reduction1_work;

    if (!output_enabled && !feedback_enabled) {
        if (channels <= 16U) {
            for (unsigned int c = 0; c < channels; c++) prev_smp[c] = prev_smp_local[c];
        }
        return;
    }

    if (limiter_maybe_above_ceiling < 0 && !feedback_enabled && channels == 6U && limiter_state_work == 0) {
        if (channels <= 16U) {
            for (unsigned int c = 0; c < channels; c++) prev_smp[c] = prev_smp_local[c];
        }
        return;
    }

    if (!LOUDNORM_EXACT_GENERIC_LIMITER && feedback_enabled && channels == 6U && limiter_maybe_above_ceiling < -1 && limiter_state_work == 0) {
        if (out_short_count && *out_short_count < 0) return;
        if (profile_counts) profile_counts[FB_D_COUNT_FEEDBACK_IIR] += (double)nb_samples * 5.0;
        add_feedback_output_dev(output, output_frame_offset, nb_samples, channels, frames_per_window, b, a, out_states, out_short_ring, out_short_sum, out_short_index, out_short_count, out_window_sum, out_window_count);
        if (channels <= 16U && nb_samples > 0U) {
            const unsigned long long last = ((unsigned long long)(output_frame_offset + nb_samples - 1U) * channels);
            for (unsigned int c = 0; c < channels; c++) prev_smp[c] = fabs(output[last + c]);
        }
        return;
    }

    if (!LOUDNORM_EXACT_GENERIC_LIMITER && feedback_enabled && channels == 6U && limiter_maybe_above_ceiling < 0 && limiter_state_work == 0) {
        if (profile_counts) profile_counts[FB_D_COUNT_FEEDBACK_IIR] += (double)nb_samples * 5.0;
        add_feedback_output_dev(output, output_frame_offset, nb_samples, channels, frames_per_window, b, a, out_states, out_short_ring, out_short_sum, out_short_index, out_short_count, out_window_sum, out_window_count);
        if (channels <= 16U) {
            for (unsigned int c = 0; c < channels; c++) prev_smp[c] = prev_smp_local[c];
        }
        return;
    }

    if (!LOUDNORM_EXACT_GENERIC_LIMITER && feedback_enabled && channels == 6U) {
        double out_window_sum_work = *out_window_sum;
        unsigned int out_window_count_work = *out_window_count;
        double out_short_sum_work = *out_short_sum;
        int out_short_index_work = *out_short_index;
        int out_short_count_work = *out_short_count;
        const double neg_ceiling = -ceiling;
        double s00 = out_states_work[0];
        double s01 = out_states_work[1];
        double s02 = out_states_work[2];
        double s03 = out_states_work[3];
        double s10 = out_states_work[4];
        double s11 = out_states_work[5];
        double s12 = out_states_work[6];
        double s13 = out_states_work[7];
        double s20 = out_states_work[8];
        double s21 = out_states_work[9];
        double s22 = out_states_work[10];
        double s23 = out_states_work[11];
        double s30 = out_states_work[12];
        double s31 = out_states_work[13];
        double s32 = out_states_work[14];
        double s33 = out_states_work[15];
        double s40 = out_states_work[16];
        double s41 = out_states_work[17];
        double s42 = out_states_work[18];
        double s43 = out_states_work[19];
        if (profile_counts) {
            profile_counts[FB_D_COUNT_OUTPUT_WRITES] += (double)nb_samples * 6.0;
            profile_counts[FB_D_COUNT_FEEDBACK_IIR] += (double)nb_samples * 5.0;
        }
        for (unsigned int n = 0; n < nb_samples; n++) {
            double frame_sum = 0.0;
            const unsigned long long output_index = ((unsigned long long)(output_frame_offset + n) * 6ULL);
            double out = limiter_buf[index + 0];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 0] = out;
            {
                double v1 = s00;
                double v2 = s01;
                double v3 = s02;
                double v4 = s03;
                double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                frame_sum += y * y;
                s03 = v3;
                s02 = v2;
                s01 = v1;
                s00 = v0;
            }

            out = limiter_buf[index + 1];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 1] = out;
            {
                double v1 = s10;
                double v2 = s11;
                double v3 = s12;
                double v4 = s13;
                double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                frame_sum += y * y;
                s13 = v3;
                s12 = v2;
                s11 = v1;
                s10 = v0;
            }

            out = limiter_buf[index + 2];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 2] = out;
            {
                double v1 = s20;
                double v2 = s21;
                double v3 = s22;
                double v4 = s23;
                double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                frame_sum += y * y;
                s23 = v3;
                s22 = v2;
                s21 = v1;
                s20 = v0;
            }

            out = limiter_buf[index + 3];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 3] = out;

            out = limiter_buf[index + 4];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 4] = out;
            {
                double v1 = s30;
                double v2 = s31;
                double v3 = s32;
                double v4 = s33;
                double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                frame_sum += y * y * 1.41;
                s33 = v3;
                s32 = v2;
                s31 = v1;
                s30 = v0;
            }

            out = limiter_buf[index + 5];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 5] = out;
            {
                double v1 = s40;
                double v2 = s41;
                double v3 = s42;
                double v4 = s43;
                double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                frame_sum += y * y * 1.41;
                s43 = v3;
                s42 = v2;
                s41 = v1;
                s40 = v0;
            }

            out_window_sum_work += frame_sum;
            out_window_count_work++;
            if (out_window_count_work == frames_per_window) {
                if (out_short_count_work == 30) {
                    out_short_sum_work -= out_short_ring[out_short_index_work];
                } else {
                    out_short_count_work++;
                }
                out_short_ring[out_short_index_work] = out_window_sum_work;
                if (profile_counts) profile_counts[FB_D_COUNT_SHORT_RING_WRITES] += 1.0;
                out_short_sum_work += out_window_sum_work;
                out_short_index_work++;
                if (out_short_index_work >= 30) out_short_index_work = 0;
                out_window_sum_work = 0.0;
                out_window_count_work = 0;
            }
            index += 6;
            if (index >= (int)limiter_buf_size) index -= (int)limiter_buf_size;
        }
        *out_window_sum = out_window_sum_work;
        *out_window_count = out_window_count_work;
        *out_short_sum = out_short_sum_work;
        *out_short_index = out_short_index_work;
        *out_short_count = out_short_count_work;
        out_states[0] = s00;
        out_states[1] = s01;
        out_states[2] = s02;
        out_states[3] = s03;
        out_states[4] = s10;
        out_states[5] = s11;
        out_states[6] = s12;
        out_states[7] = s13;
        out_states[8] = s20;
        out_states[9] = s21;
        out_states[10] = s22;
        out_states[11] = s23;
        out_states[12] = s30;
        out_states[13] = s31;
        out_states[14] = s32;
        out_states[15] = s33;
        out_states[16] = s40;
        out_states[17] = s41;
        out_states[18] = s42;
        out_states[19] = s43;
        if (channels <= 16U) {
            for (unsigned int c = 0; c < channels; c++) prev_smp[c] = prev_smp_local[c];
        }
        return;
    }

    const double neg_ceiling = -ceiling;
    if (!LOUDNORM_EXACT_GENERIC_LIMITER && !feedback_enabled && channels == 6U) {
        if (profile_counts) profile_counts[FB_D_COUNT_OUTPUT_WRITES] += (double)nb_samples * 6.0;
        for (unsigned int n = 0; n < nb_samples; n++) {
            const unsigned long long output_index = ((unsigned long long)(output_frame_offset + n) * 6ULL);
            double out = limiter_buf[index + 0];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 0] = out;
            out = limiter_buf[index + 1];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 1] = out;
            out = limiter_buf[index + 2];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 2] = out;
            out = limiter_buf[index + 3];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 3] = out;
            out = limiter_buf[index + 4];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 4] = out;
            out = limiter_buf[index + 5];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 5] = out;
            index += 6;
            if (index >= (int)limiter_buf_size) index -= (int)limiter_buf_size;
        }
        if (channels <= 16U) {
            for (unsigned int c = 0; c < channels; c++) prev_smp[c] = prev_smp_local[c];
        }
        return;
    }
    if (!LOUDNORM_EXACT_GENERIC_LIMITER && !feedback_enabled && channels == 2U) {
        if (profile_counts) profile_counts[FB_D_COUNT_OUTPUT_WRITES] += (double)nb_samples * 2.0;
        for (unsigned int n = 0; n < nb_samples; n++) {
            const unsigned long long output_index = ((unsigned long long)(output_frame_offset + n) * 2ULL);
            double out = limiter_buf[index + 0];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 0] = out;
            out = limiter_buf[index + 1];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 1] = out;
            index += 2;
            if (index >= (int)limiter_buf_size) index -= (int)limiter_buf_size;
        }
        if (channels <= 16U) {
            for (unsigned int c = 0; c < channels; c++) prev_smp[c] = prev_smp_local[c];
        }
        return;
    }
    const int source_stereo_feedback = source_faithful_stereo && feedback_enabled && channels == 2U && source_out_short_ring0 && source_out_short_ring1 && source_out_window_sum0 && source_out_window_sum1;
    double source_window_sum0 = source_stereo_feedback ? *source_out_window_sum0 : 0.0;
    double source_window_sum1 = source_stereo_feedback ? *source_out_window_sum1 : 0.0;
    if (profile_counts) profile_counts[FB_D_COUNT_OUTPUT_WRITES] += (double)nb_samples * (double)channels;
    for (unsigned int n = 0; n < nb_samples; n++) {
        double frame_sum = 0.0;
        for (unsigned int c = 0; c < channels; c++) {
            double out = limiter_buf[index + (int)c];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[((unsigned long long)(output_frame_offset + n) * channels) + c] = out;
            if (feedback_enabled) {
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
                if (slot >= 0) {
                    if (profile_counts) profile_counts[FB_D_COUNT_FEEDBACK_IIR] += 1.0;
                    const unsigned int base = (unsigned int)slot * 4U;
                    double v1 = out_states_work[base + 0];
                    double v2 = out_states_work[base + 1];
                    double v3 = out_states_work[base + 2];
                    double v4 = out_states_work[base + 3];
                    double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                    double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                    const double energy = y * y * (slot >= 3 ? 1.41 : 1.0);
                    if (source_stereo_feedback) {
                        if (c == 0U) source_window_sum0 += energy;
                        else if (c == 1U) source_window_sum1 += energy;
                    } else {
                        frame_sum += energy;
                    }
                    out_states_work[base + 3] = v3;
                    out_states_work[base + 2] = v2;
                    out_states_work[base + 1] = v1;
                    out_states_work[base + 0] = v0;
                }
            }
        }
        if (feedback_enabled) {
            if (source_stereo_feedback) {
                *out_window_sum = source_window_sum0 + source_window_sum1;
            } else {
                *out_window_sum += frame_sum;
            }
            (*out_window_count)++;
            if (*out_window_count == frames_per_window) {
                if (source_stereo_feedback) {
                    if (*out_short_count < 30) (*out_short_count)++;
                    source_out_short_ring0[*out_short_index] = source_window_sum0;
                    source_out_short_ring1[*out_short_index] = source_window_sum1;
                    out_short_ring[*out_short_index] = source_window_sum0 + source_window_sum1;
                    if (profile_counts) profile_counts[FB_D_COUNT_SHORT_RING_WRITES] += 1.0;
                    *out_short_sum = source_stereo_recompute_short_sum_dev(source_out_short_ring0, source_out_short_ring1);
                    (*out_short_index)++;
                    if (*out_short_index >= 30) *out_short_index = 0;
                    source_window_sum0 = 0.0;
                    source_window_sum1 = 0.0;
                    *out_window_sum = 0.0;
                    *out_window_count = 0;
                } else {
                    if (*out_short_count == 30) {
                        *out_short_sum -= out_short_ring[*out_short_index];
                    } else {
                        (*out_short_count)++;
                    }
                    out_short_ring[*out_short_index] = *out_window_sum;
                    if (profile_counts) profile_counts[FB_D_COUNT_SHORT_RING_WRITES] += 1.0;
                    *out_short_sum += *out_window_sum;
                    (*out_short_index)++;
                    if (*out_short_index >= 30) *out_short_index = 0;
                    *out_window_sum = 0.0;
                    *out_window_count = 0;
                }
            }
        }
        index += channels;
        if (index >= (int)limiter_buf_size) index -= (int)limiter_buf_size;
    }
    if (feedback_enabled) {
        for (int i = 0; i < 20; i++) out_states[i] = out_states_work[i];
        if (source_stereo_feedback) {
            *source_out_window_sum0 = source_window_sum0;
            *source_out_window_sum1 = source_window_sum1;
        }
    }
    if (channels <= 16U) {
        for (unsigned int c = 0; c < channels; c++) prev_smp[c] = prev_smp_local[c];
    }
}

extern "C" __device__ int ebur_channel_slot_dev(unsigned int channels, unsigned int c) {
    if (channels == 4) {
        if (c == 0) return 0;
        if (c == 1) return 1;
        if (c == 2) return 3;
        if (c == 3) return 4;
        return -1;
    }
    if (channels == 5) {
        if (c == 0) return 0;
        if (c == 1) return 1;
        if (c == 2) return 2;
        if (c == 3) return 3;
        if (c == 4) return 4;
        return -1;
    }
    if (c == 0) return 0;
    if (c == 1) return 1;
    if (c == 2) return 2;
    if (c == 4) return 3;
    if (c == 5) return 4;
    return -1;
}

extern "C" __device__ double ebur_slot_weight_dev(int slot) {
    return slot >= 3 ? 1.41 : 1.0;
}

extern "C" __global__ void kweight_window_sums_f64_stream_kernel(
    const double *input,
    double *sums,
    unsigned int *state_i,
    double *state_d,
    unsigned int frames,
    unsigned int channels,
    unsigned int frames_per_window,
    const double *b,
    const double *a
) {
    if (blockIdx.x != 0 || threadIdx.x != 0) return;
    unsigned int window_index = state_i[0];
    unsigned int window_count = state_i[1];
    double window_sum = state_d[(unsigned long long)channels * 4ULL];
    if (channels <= 16U) {
        double v1s[16];
        double v2s[16];
        double v3s[16];
        double v4s[16];
        for (unsigned int c = 0; c < channels; c++) {
            const unsigned long long base = (unsigned long long)c * 4ULL;
            v1s[c] = state_d[base + 0];
            v2s[c] = state_d[base + 1];
            v3s[c] = state_d[base + 2];
            v4s[c] = state_d[base + 3];
        }
        for (unsigned int n = 0; n < frames; n++) {
            double frame_sum = 0.0;
            for (unsigned int c = 0; c < channels; c++) {
                const int slot = ebur_channel_slot_dev(channels, c);
                if (slot < 0) continue;
                const double x = input[((unsigned long long)n * channels) + c];
                const double v0 = kweight_v0_rn_dev(x, a, v1s[c], v2s[c], v3s[c], v4s[c]);
                const double y = kweight_y_rn_dev(b, v0, v1s[c], v2s[c], v3s[c], v4s[c]);
                frame_sum += y * y * ebur_slot_weight_dev(slot);
                v4s[c] = v3s[c];
                v3s[c] = v2s[c];
                v2s[c] = v1s[c];
                v1s[c] = v0;
            }
            window_sum += frame_sum;
            window_count++;
            if (window_count == frames_per_window) {
                sums[window_index] = window_sum;
                window_index++;
                window_sum = 0.0;
                window_count = 0;
            }
        }
        for (unsigned int c = 0; c < channels; c++) {
            const unsigned long long base = (unsigned long long)c * 4ULL;
            state_d[base + 0] = v1s[c];
            state_d[base + 1] = v2s[c];
            state_d[base + 2] = v3s[c];
            state_d[base + 3] = v4s[c];
        }
        if (window_count > 0) sums[window_index] = window_sum;
        state_i[0] = window_index;
        state_i[1] = window_count;
        state_d[(unsigned long long)channels * 4ULL] = window_sum;
        return;
    }
    for (unsigned int n = 0; n < frames; n++) {
        double frame_sum = 0.0;
        for (unsigned int c = 0; c < channels; c++) {
            const int slot = ebur_channel_slot_dev(channels, c);
            if (slot < 0) continue;
            const unsigned long long base = (unsigned long long)c * 4ULL;
            double v1 = state_d[base + 0];
            double v2 = state_d[base + 1];
            double v3 = state_d[base + 2];
            double v4 = state_d[base + 3];
            const double x = input[((unsigned long long)n * channels) + c];
            const double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
            const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
            frame_sum += y * y * ebur_slot_weight_dev(slot);
            state_d[base + 3] = v3;
            state_d[base + 2] = v2;
            state_d[base + 1] = v1;
            state_d[base + 0] = v0;
        }
        window_sum += frame_sum;
        window_count++;
        if (window_count == frames_per_window) {
            sums[window_index] = window_sum;
            window_index++;
            window_sum = 0.0;
            window_count = 0;
        }
    }
    if (window_count > 0) sums[window_index] = window_sum;
    state_i[0] = window_index;
    state_i[1] = window_count;
    state_d[(unsigned long long)channels * 4ULL] = window_sum;
}

extern "C" __device__ void add_feedback_output_dev(
    const double *output,
    unsigned int output_frame_offset,
    unsigned int nb_samples,
    unsigned int channels,
    unsigned int frames_per_window,
    const double *b,
    const double *a,
    double *out_states,
    double *out_short_ring,
    double *out_short_sum,
    int *out_short_index,
    int *out_short_count,
    double *out_window_sum,
    unsigned int *out_window_count
) {
    if (!LOUDNORM_EXACT_GENERIC_LIMITER && channels == 6U) {
        double out_window_sum_work = *out_window_sum;
        unsigned int out_window_count_work = *out_window_count;
        double out_short_sum_work = *out_short_sum;
        int out_short_index_work = *out_short_index;
        int out_short_count_work = *out_short_count;
        double s00 = out_states[0];
        double s01 = out_states[1];
        double s02 = out_states[2];
        double s03 = out_states[3];
        double s10 = out_states[4];
        double s11 = out_states[5];
        double s12 = out_states[6];
        double s13 = out_states[7];
        double s20 = out_states[8];
        double s21 = out_states[9];
        double s22 = out_states[10];
        double s23 = out_states[11];
        double s30 = out_states[12];
        double s31 = out_states[13];
        double s32 = out_states[14];
        double s33 = out_states[15];
        double s40 = out_states[16];
        double s41 = out_states[17];
        double s42 = out_states[18];
        double s43 = out_states[19];
        for (unsigned int n = 0; n < nb_samples; n++) {
            double frame_sum = 0.0;
            const unsigned long long output_index = ((unsigned long long)(output_frame_offset + n) * 6ULL);
            double x = output[output_index + 0];
            double v0 = kweight_v0_rn_dev(x, a, s00, s01, s02, s03);
            double y = kweight_y_rn_dev(b, v0, s00, s01, s02, s03);
            frame_sum += y * y;
            s03 = s02;
            s02 = s01;
            s01 = s00;
            s00 = v0;

            x = output[output_index + 1];
            v0 = kweight_v0_rn_dev(x, a, s10, s11, s12, s13);
            y = kweight_y_rn_dev(b, v0, s10, s11, s12, s13);
            frame_sum += y * y;
            s13 = s12;
            s12 = s11;
            s11 = s10;
            s10 = v0;

            x = output[output_index + 2];
            v0 = kweight_v0_rn_dev(x, a, s20, s21, s22, s23);
            y = kweight_y_rn_dev(b, v0, s20, s21, s22, s23);
            frame_sum += y * y;
            s23 = s22;
            s22 = s21;
            s21 = s20;
            s20 = v0;

            x = output[output_index + 4];
            v0 = kweight_v0_rn_dev(x, a, s30, s31, s32, s33);
            y = kweight_y_rn_dev(b, v0, s30, s31, s32, s33);
            frame_sum += (y * y) * 1.41;
            s33 = s32;
            s32 = s31;
            s31 = s30;
            s30 = v0;

            x = output[output_index + 5];
            v0 = kweight_v0_rn_dev(x, a, s40, s41, s42, s43);
            y = kweight_y_rn_dev(b, v0, s40, s41, s42, s43);
            frame_sum += (y * y) * 1.41;
            s43 = s42;
            s42 = s41;
            s41 = s40;
            s40 = v0;

            out_window_sum_work += frame_sum;
            out_window_count_work++;
            if (out_window_count_work == frames_per_window) {
                if (out_short_count_work == 30) {
                    out_short_sum_work -= out_short_ring[out_short_index_work];
                } else {
                    out_short_count_work++;
                }
                out_short_ring[out_short_index_work] = out_window_sum_work;
                out_short_sum_work += out_window_sum_work;
                out_short_index_work++;
                if (out_short_index_work >= 30) out_short_index_work = 0;
                out_window_sum_work = 0.0;
                out_window_count_work = 0;
            }
        }
        out_states[0] = s00;
        out_states[1] = s01;
        out_states[2] = s02;
        out_states[3] = s03;
        out_states[4] = s10;
        out_states[5] = s11;
        out_states[6] = s12;
        out_states[7] = s13;
        out_states[8] = s20;
        out_states[9] = s21;
        out_states[10] = s22;
        out_states[11] = s23;
        out_states[12] = s30;
        out_states[13] = s31;
        out_states[14] = s32;
        out_states[15] = s33;
        out_states[16] = s40;
        out_states[17] = s41;
        out_states[18] = s42;
        out_states[19] = s43;
        *out_short_sum = out_short_sum_work;
        *out_short_index = out_short_index_work;
        *out_short_count = out_short_count_work;
        *out_window_sum = out_window_sum_work;
        *out_window_count = out_window_count_work;
        return;
    }
    for (unsigned int n = 0; n < nb_samples; n++) {
        double frame_sum = 0.0;
        for (unsigned int c = 0; c < channels; c++) {
            int slot = ebur_channel_slot_dev(channels, c);
            if (slot < 0) continue;
            const unsigned int base = (unsigned int)slot * 4U;
            double v1 = out_states[base + 0];
            double v2 = out_states[base + 1];
            double v3 = out_states[base + 2];
            double v4 = out_states[base + 3];
            double x = output[((unsigned long long)(output_frame_offset + n) * channels) + c];
            double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
            double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
            frame_sum += y * y * ebur_slot_weight_dev(slot);
            out_states[base + 3] = v3;
            out_states[base + 2] = v2;
            out_states[base + 1] = v1;
            out_states[base + 0] = v0;
        }
        *out_window_sum += frame_sum;
        (*out_window_count)++;
        if (*out_window_count == frames_per_window) {
            if (*out_short_count == 30) {
                *out_short_sum -= out_short_ring[*out_short_index];
            } else {
                (*out_short_count)++;
            }
            out_short_ring[*out_short_index] = *out_window_sum;
            *out_short_sum += *out_window_sum;
            (*out_short_index)++;
            if (*out_short_index >= 30) *out_short_index = 0;
            *out_window_sum = 0.0;
            *out_window_count = 0;
        }
    }
}

#define FB_I_INITIALIZED 0
#define FB_I_SHORT_INDEX 1
#define FB_I_OUT_SHORT_INDEX 2
#define FB_I_SHORT_COUNT 3
#define FB_I_OUT_SHORT_COUNT 4
#define FB_I_OUT_WINDOW_COUNT 5
#define FB_I_DELTA_INDEX 6
#define FB_I_ABOVE_THRESHOLD 7
#define FB_I_OUT_FRAME 8
#define FB_I_WRITE_FRAME 9
#define FB_I_WRITE_INDEX 10
#define FB_I_INPUT_WINDOW 11
#define FB_I_FRAME_TYPE 12
#define FB_I_LIMITER_STATE 13
#define FB_I_PEAK_INDEX 14
#define FB_I_ENV_INDEX 15
#define FB_I_ENV_CNT 16
#define FB_I_ATTACK_STATE 17
#define FB_I_FIRST 18
#define FB_I_FINAL_INITIALIZED 19
#define FB_I_FINAL_SRC_OFFSET 20
#define FB_I_INPUT_MISSING 21
#define FB_I_PROFILE_COUNTS 22
#define FB_I_LIMITER_MAYBE_ABOVE_CEILING 23
#define FB_I_PREFILLED_OUTPUT 24
#define FB_I_PREFILL_CHUNK_SAFE 25
#define FB_I_SKIP_SAFE_FILL 26
#define FB_I_SKIP_SAFE_FEEDBACK 27
#define FB_I_FORCE_SAFE_IDLE 28
#define FB_I_SAFE_FEEDBACK_WINDOW_ACCUM 29
#define FB_I_SAFE_FEEDBACK_SLOT_ACCUM 30
#define FB_I_PARALLEL_UNSAFE_FEEDBACK 31

#define SAFE_FEEDBACK_TILE_FRAMES 512U

#define FB_D_SHORT_RING 0
#define FB_D_OUT_SHORT_RING 30
#define FB_D_DELTA 60
#define FB_D_OUT_STATES 90
#define FB_D_SHORT_SUM 110
#define FB_D_OUT_SHORT_SUM 111
#define FB_D_OUT_WINDOW_SUM 112
#define FB_D_PREV_DELTA 113
#define FB_D_GAIN_REDUCTION0 114
#define FB_D_GAIN_REDUCTION1 115
#define FB_D_SOURCE_OUT_SHORT_RING0 128
#define FB_D_SOURCE_OUT_SHORT_RING1 158
#define FB_D_SOURCE_OUT_WINDOW_SUM0 188
#define FB_D_SOURCE_OUT_WINDOW_SUM1 189
#define FB_D_SOURCE_IN_STATE0 190
#define FB_D_SOURCE_IN_STATE1 194

extern "C" __global__ void safe_feedback_channel_energy_f64_kernel(
    const double *output,
    double *frame_energy,
    double *state_d,
    unsigned int frames,
    unsigned int channels,
    const double *b,
    const double *a
) {
    const unsigned int c = blockIdx.x;
    if (threadIdx.x != 0 || channels != 6U || c >= channels) return;
    const int slot = ebur_channel_slot_dev(channels, c);
    if (slot < 0) return;
    const double weight = ebur_slot_weight_dev(slot);
    double *out_states = state_d + FB_D_OUT_STATES;
    const unsigned int base = (unsigned int)slot * 4U;
    double v1 = out_states[base + 0];
    double v2 = out_states[base + 1];
    double v3 = out_states[base + 2];
    double v4 = out_states[base + 3];
    for (unsigned int n = 0; n < frames; n++) {
        const double x = output[((unsigned long long)n * 6ULL) + c];
        const double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
        const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
        frame_energy[((unsigned long long)n * 5ULL) + (unsigned int)slot] = y * y * weight;
        v4 = v3;
        v3 = v2;
        v2 = v1;
        v1 = v0;
    }
    out_states[base + 0] = v1;
    out_states[base + 1] = v2;
    out_states[base + 2] = v3;
    out_states[base + 3] = v4;
}

extern "C" __global__ void safe_feedback_window_sums_f64_kernel(
    const double *frame_energy,
    double *window_sums,
    unsigned int frames,
    unsigned int frames_per_window
) {
    const unsigned int local_windows = (frames + frames_per_window - 1U) / frames_per_window;
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int local_w = blockIdx.x * blockDim.x + threadIdx.x; local_w < local_windows; local_w += stride) {
        const unsigned int start = local_w * frames_per_window;
        unsigned int end = start + frames_per_window;
        if (end > frames) end = frames;
        double window_sum = 0.0;
        for (unsigned int n = start; n < end; n++) {
            const unsigned long long base = (unsigned long long)n * 5ULL;
            double frame_sum = 0.0;
            frame_sum += frame_energy[base + 0];
            frame_sum += frame_energy[base + 1];
            frame_sum += frame_energy[base + 2];
            frame_sum += frame_energy[base + 3];
            frame_sum += frame_energy[base + 4];
            window_sum += frame_sum;
        }
        window_sums[local_w] = window_sum;
    }
}

extern "C" __global__ void safe_feedback_stitch_f64_kernel(
    unsigned int *state_i,
    double *state_d,
    unsigned int *hist,
    const double *output,
    double *prev_smp,
    const double *input_window_sums,
    const double *feedback_window_sums,
    const double *hist_energies,
    const double *hist_boundaries,
    unsigned int local_windows,
    unsigned int total_frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    unsigned int limiter_lookahead_frames,
    double target_i,
    double target_lra,
    double measured_i,
    double measured_thresh,
    double ceiling,
    double *fill_gain_pairs,
    unsigned int fill_gain_lead,
    unsigned int fill_gain_count,
    unsigned int source_faithful_stereo
) {
    if (blockIdx.x != 0 || threadIdx.x != 0 || (channels != 6U && channels != 2U)) return;
    const int source_precomputed = source_faithful_stereo >= 2U && channels == 2U && input_window_sums;
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
    double *short_ring = state_d + FB_D_SHORT_RING;
    double *out_short_ring = state_d + FB_D_OUT_SHORT_RING;
    double *delta = state_d + FB_D_DELTA;
    unsigned int short_index = state_i[FB_I_SHORT_INDEX];
    int out_short_index = (int)state_i[FB_I_OUT_SHORT_INDEX];
    unsigned int short_count = state_i[FB_I_SHORT_COUNT];
    int out_short_count = (int)state_i[FB_I_OUT_SHORT_COUNT];
    unsigned int out_window_count = state_i[FB_I_OUT_WINDOW_COUNT];
    int index = (int)state_i[FB_I_DELTA_INDEX];
    int above_threshold = (int)state_i[FB_I_ABOVE_THRESHOLD];
    unsigned int out_frame = state_i[FB_I_OUT_FRAME];
    unsigned int write_frame = state_i[FB_I_WRITE_FRAME];
    unsigned int write_index = state_i[FB_I_WRITE_INDEX];
    unsigned int input_window = state_i[FB_I_INPUT_WINDOW];
    int frame_type = (int)state_i[FB_I_FRAME_TYPE];
    int first = (int)state_i[FB_I_FIRST];
    double short_sum = state_d[FB_D_SHORT_SUM];
    double out_short_sum = state_d[FB_D_OUT_SHORT_SUM];
    double out_window_sum = state_d[FB_D_OUT_WINDOW_SUM];
    double prev_delta = state_d[FB_D_PREV_DELTA];
    unsigned int produced = 0U;
    (void)ceiling;
    (void)measured_i;

    if (fill_gain_pairs) {
        for (unsigned int i = 0; i < fill_gain_lead && i < fill_gain_count; i++) {
            int gain_index = index + (int)i - (int)fill_gain_lead;
            while (gain_index < 0) gain_index += 30;
            while (gain_index >= 30) gain_index -= 30;
            int gain_next_index = gain_index + 1;
            if (gain_next_index >= 30) gain_next_index -= 30;
            fill_gain_pairs[(unsigned long long)i * 2ULL] = gaussian_filter_dev(delta, weights, (gain_index + 10) < 30 ? (gain_index + 10) : (gain_index + 10 - 30));
            fill_gain_pairs[(unsigned long long)i * 2ULL + 1ULL] = gaussian_filter_dev(delta, weights, (gain_next_index + 10) < 30 ? (gain_next_index + 10) : (gain_next_index + 10 - 30));
        }
    }

    for (unsigned int local_w = 0; local_w < local_windows && out_frame < total_frames; local_w++) {
        if (fill_gain_pairs) {
            const unsigned int gain_slot = fill_gain_lead + local_w;
            if (gain_slot < fill_gain_count) {
                fill_gain_pairs[(unsigned long long)gain_slot * 2ULL] = gaussian_filter_dev(delta, weights, (index + 10) < 30 ? (index + 10) : (index + 10 - 30));
                fill_gain_pairs[(unsigned long long)gain_slot * 2ULL + 1ULL] = gaussian_filter_dev(delta, weights, (index + 11) < 30 ? (index + 11) : (index + 11 - 30));
            }
        }
        unsigned int nb = frames_per_window;
        if (nb > total_frames - out_frame) nb = total_frames - out_frame;
        if (!first) {
            write_index += nb;
            while (write_index >= limiter_lookahead_frames) write_index -= limiter_lookahead_frames;
            write_frame += nb;
            if (nb < frames_per_window) {
                write_index += frames_per_window - nb;
                while (write_index >= limiter_lookahead_frames) write_index -= limiter_lookahead_frames;
            }
        }

        if (feedback_window_sums) {
            out_window_sum += feedback_window_sums[local_w];
            out_window_count += nb;
            if (out_window_count == frames_per_window) {
                if (out_short_count == 30) {
                    out_short_sum -= out_short_ring[out_short_index];
                } else {
                    out_short_count++;
                }
                out_short_ring[out_short_index] = out_window_sum;
                out_short_sum += out_window_sum;
                out_short_index++;
                if (out_short_index >= 30) out_short_index = 0;
                out_window_sum = 0.0;
                out_window_count = 0;
            }
        }
        out_frame += nb;
        produced += nb;
        frame_type = 1;
        if (first) {
            first = 0;
            continue;
        }

        if (input_window < windows) {
            double input_window_sum = input_window_sums[input_window];
            double input_hist4_sum = 0.0;
            double input_short_sum = 0.0;
            if (source_precomputed) {
                const unsigned long long source_base = (unsigned long long)input_window * 3ULL;
                input_window_sum = input_window_sums[source_base + 0ULL];
                input_hist4_sum = input_window >= 3U ? input_window_sums[source_base + 1ULL] : 0.0;
                input_short_sum = input_window_sums[source_base + 2ULL];
            }
            if (short_count == 30) {
                short_sum -= short_ring[short_index];
            } else {
                short_count++;
            }
            short_ring[short_index] = input_window_sum;
            short_sum += input_window_sum;
            short_index++;
            if (short_index >= 30) short_index = 0;
            if (source_precomputed) short_sum = input_short_sum;
            if (input_window >= 3) {
                double e = (source_precomputed ? input_hist4_sum : (input_window_sums[input_window] + input_window_sums[input_window - 1] + input_window_sums[input_window - 2] + input_window_sums[input_window - 3])) / (double)(frames_per_window * 4U);
                if (e >= hist_boundaries[0]) hist[hist_index_from_boundaries_dev(e, hist_boundaries)]++;
            }
        }

        const double global = gated_loudness_lut_boundaries_dev(hist, hist_energies, hist_boundaries);
        const double shortterm = energy_to_loudness_dev(short_sum / (double)(frames_per_window * 30U));
        const double relative_threshold = relative_threshold_lut_dev(hist, hist_energies);
        if (above_threshold == 0) {
            double shortterm_out = energy_to_loudness_dev(out_short_sum / (double)(frames_per_window * 30U));
            if (shortterm > measured_thresh) prev_delta *= 1.0058;
            if (shortterm_out >= target_i) above_threshold = 1;
        }
        if (shortterm < relative_threshold || shortterm <= -70.0 || above_threshold == 0) {
            delta[index] = prev_delta;
        } else {
            double diff = isfinite(global) ? (shortterm - global) : 0.0;
            double limit = target_lra / 2.0;
            double env_global = fabs(diff) < limit ? diff : (diff < 0.0 ? -limit : limit);
            double env_shortterm = target_i - shortterm;
            delta[index] = db_to_amp_dev(env_global + env_shortterm);
        }
        prev_delta = delta[index];
        index++;
        if (index >= 30) index = 0;
        input_window++;
    }

    state_i[FB_I_SHORT_INDEX] = short_index;
    state_i[FB_I_OUT_SHORT_INDEX] = (unsigned int)out_short_index;
    state_i[FB_I_SHORT_COUNT] = short_count;
    state_i[FB_I_OUT_SHORT_COUNT] = (unsigned int)out_short_count;
    state_i[FB_I_OUT_WINDOW_COUNT] = out_window_count;
    state_i[FB_I_DELTA_INDEX] = (unsigned int)index;
    state_i[FB_I_ABOVE_THRESHOLD] = (unsigned int)above_threshold;
    state_i[FB_I_OUT_FRAME] = out_frame;
    state_i[FB_I_WRITE_FRAME] = write_frame;
    state_i[FB_I_WRITE_INDEX] = write_index;
    state_i[FB_I_INPUT_WINDOW] = input_window;
    state_i[FB_I_FRAME_TYPE] = (unsigned int)frame_type;
    state_i[FB_I_FIRST] = (unsigned int)first;
    state_i[FB_I_LIMITER_MAYBE_ABOVE_CEILING] = 0;
    state_i[FB_I_SKIP_SAFE_FILL] = 0;
    state_i[FB_I_SKIP_SAFE_FEEDBACK] = 0;
    state_i[FB_I_FORCE_SAFE_IDLE] = 0;
    state_d[FB_D_SHORT_SUM] = short_sum;
    state_d[FB_D_OUT_SHORT_SUM] = out_short_sum;
    state_d[FB_D_OUT_WINDOW_SUM] = out_window_sum;
    state_d[FB_D_PREV_DELTA] = prev_delta;
    if (produced > 0U) {
        const unsigned long long last = ((unsigned long long)(produced - 1U) * (unsigned long long)channels);
        for (unsigned int c = 0; c < channels; c++) prev_smp[c] = fabs(output[last + c]);
    }
}

extern "C" __global__ void safe_feedback_fill_prefilled_exact_f64_kernel(
    const double *input,
    double *output,
    double *limiter_buf,
    double *prev_smp,
    const double *fill_gain_pairs,
    unsigned int samples,
    unsigned int output_frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int limiter_lookahead_frames,
    unsigned int output_frame_offset,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int write_frame_start,
    unsigned int fill_gain_lead,
    unsigned int fill_gain_count,
    double offset_amp,
    double ceiling
) {
    const unsigned int idx0 = blockIdx.x * blockDim.x + threadIdx.x;
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int idx = idx0; idx < samples; idx += stride) {
        const unsigned int local_frame = idx / channels;
        const unsigned int c = idx - local_frame * channels;
        const unsigned int frame = output_frame_offset + local_frame;
        if (frame < write_frame_start) {
            unsigned int src_frame = frame;
            while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
            double out = limiter_buf[((unsigned long long)src_frame * channels) + c];
            if (out > ceiling) out = ceiling;
            else if (out < -ceiling) out = -ceiling;
            if (local_frame < output_frames) {
                output[idx] = out;
                if (prev_smp && local_frame + 1U == output_frames) prev_smp[c] = fabs(out);
            }
            continue;
        }
        const long long rel = (long long)frame - (long long)write_frame_start;
        long long fill_window = rel >= 0
            ? rel / (long long)frames_per_window
            : -(((-rel) + (long long)frames_per_window - 1LL) / (long long)frames_per_window);
        long long fill_start = (long long)write_frame_start + (fill_window * (long long)frames_per_window);
        unsigned int pos = (unsigned int)((long long)frame - fill_start);
        long long gain_slot_signed = fill_window + (long long)fill_gain_lead;
        if (gain_slot_signed < 0) gain_slot_signed = 0;
        if ((unsigned long long)gain_slot_signed >= (unsigned long long)fill_gain_count) gain_slot_signed = (long long)fill_gain_count - 1LL;
        const unsigned int gain_slot = (unsigned int)gain_slot_signed;
        const double gain = fill_gain_pairs[(unsigned long long)gain_slot * 2ULL];
        const double gain_next = fill_gain_pairs[(unsigned long long)gain_slot * 2ULL + 1ULL];
        const double timed_gain = gain + (((double)pos / (double)frames_per_window) * (gain_next - gain));
        double x = 0.0;
        if (frame >= input_base_frame && frame < input_base_frame + input_frames) {
            x = input[((unsigned long long)(frame - input_base_frame) * channels) + c];
        }
        double v = (x * timed_gain) * offset_amp;
        unsigned int dst_frame = frame;
        while (dst_frame >= limiter_lookahead_frames) dst_frame -= limiter_lookahead_frames;
        limiter_buf[((unsigned long long)dst_frame * channels) + c] = v;
        double out = v;
        if (out > ceiling) out = ceiling;
        else if (out < -ceiling) out = -ceiling;
        if (local_frame < output_frames) {
            output[idx] = out;
            if (prev_smp && local_frame + 1U == output_frames) prev_smp[c] = fabs(out);
        }
    }
}

extern "C" __global__ void safe_feedback_apply6_f64_kernel(
    const double *input,
    double *output,
    const double *window_sums,
    const double *hist_energies,
    const double *hist_boundaries,
    double *limiter_buf,
    double *prev_smp,
    unsigned int *state_i,
    double *state_d,
    unsigned int *hist,
    double *frame_energy,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int output_frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    unsigned int limiter_lookahead_frames,
    unsigned int attack_length,
    unsigned int release_length,
    const double *b,
    const double *a,
    double target_i,
    double target_lra,
    double measured_i,
    double measured_thresh,
    double offset_amp,
    double ceiling,
    const double *source_channel_sums,
    unsigned int source_faithful_stereo
) {
    const unsigned int c = threadIdx.x;
    if (blockIdx.x != 0 || (channels != 6U && channels != 2U) || c >= channels) return;
    const int source_precomputed = (source_faithful_stereo >= 2U && channels == 2U && source_channel_sums);
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
    double *short_ring = state_d + FB_D_SHORT_RING;
    double *out_short_ring = state_d + FB_D_OUT_SHORT_RING;
    double *delta = state_d + FB_D_DELTA;
    double *out_states = state_d + FB_D_OUT_STATES;
    const int slot = ebur_channel_slot_dev(channels, c);
    const double weight = slot >= 0 ? ebur_slot_weight_dev(slot) : 0.0;
    const unsigned int state_base = slot >= 0 ? (unsigned int)slot * 4U : 0U;
    double v1 = slot >= 0 ? out_states[state_base + 0] : 0.0;
    double v2 = slot >= 0 ? out_states[state_base + 1] : 0.0;
    double v3 = slot >= 0 ? out_states[state_base + 2] : 0.0;
    double v4 = slot >= 0 ? out_states[state_base + 3] : 0.0;

    __shared__ unsigned int short_index_s;
    __shared__ unsigned int short_count_s;
    __shared__ unsigned int out_window_count_s;
    __shared__ unsigned int out_frame_s;
    __shared__ unsigned int write_frame_s;
    __shared__ unsigned int write_index_s;
    __shared__ unsigned int input_window_s;
    __shared__ unsigned int produced_s;
    __shared__ unsigned int nb_s;
    __shared__ int out_short_index_s;
    __shared__ int out_short_count_s;
    __shared__ int delta_index_s;
    __shared__ int above_threshold_s;
    __shared__ int frame_type_s;
    __shared__ int first_s;
    __shared__ int skip_prefilled_s;
    __shared__ int skip_feedback_s;
    __shared__ double short_sum_s;
    __shared__ double out_short_sum_s;
    __shared__ double out_window_sum_s;
    __shared__ double prev_delta_s;
    __shared__ double gain_s;
    __shared__ double gain_diff_s;
    __shared__ unsigned int output_limiter_index_s;
    __shared__ int window_accum_s;
    __shared__ int slot_accum_s;
    __shared__ int parallel_unsafe_s;
    __shared__ int parallel_unsafe_direct_s;
    __shared__ int limiter_maybe_above_s;
    __shared__ int limiter_state_s;
    __shared__ int peak_index_s;
    __shared__ int env_index_s;
    __shared__ int env_cnt_s;
    __shared__ int attack_state_s;
    __shared__ double window_sum_s;
    __shared__ double slot_sum_s[5];
    __shared__ double tile_energy_s[SAFE_FEEDBACK_TILE_FRAMES * 5U];
    __shared__ double gain_reduction0_s;
    __shared__ double gain_reduction1_s;

    if (c == 0U) {
        short_index_s = state_i[FB_I_SHORT_INDEX];
        short_count_s = state_i[FB_I_SHORT_COUNT];
        out_window_count_s = state_i[FB_I_OUT_WINDOW_COUNT];
        out_frame_s = state_i[FB_I_OUT_FRAME];
        write_frame_s = state_i[FB_I_WRITE_FRAME];
        write_index_s = state_i[FB_I_WRITE_INDEX];
        input_window_s = state_i[FB_I_INPUT_WINDOW];
        produced_s = 0U;
        out_short_index_s = (int)state_i[FB_I_OUT_SHORT_INDEX];
        out_short_count_s = (int)state_i[FB_I_OUT_SHORT_COUNT];
        delta_index_s = (int)state_i[FB_I_DELTA_INDEX];
        above_threshold_s = (int)state_i[FB_I_ABOVE_THRESHOLD];
        frame_type_s = (int)state_i[FB_I_FRAME_TYPE];
        first_s = (int)state_i[FB_I_FIRST];
        short_sum_s = state_d[FB_D_SHORT_SUM];
        out_short_sum_s = state_d[FB_D_OUT_SHORT_SUM];
        out_window_sum_s = state_d[FB_D_OUT_WINDOW_SUM];
        prev_delta_s = state_d[FB_D_PREV_DELTA];
        window_accum_s = state_i[FB_I_SAFE_FEEDBACK_WINDOW_ACCUM] ? 1 : 0;
        slot_accum_s = state_i[FB_I_SAFE_FEEDBACK_SLOT_ACCUM] ? 1 : 0;
        parallel_unsafe_s = state_i[FB_I_PARALLEL_UNSAFE_FEEDBACK] ? 1 : 0;
        limiter_maybe_above_s = (int)state_i[FB_I_LIMITER_MAYBE_ABOVE_CEILING];
        limiter_state_s = (int)state_i[FB_I_LIMITER_STATE];
        peak_index_s = (int)state_i[FB_I_PEAK_INDEX];
        env_index_s = (int)state_i[FB_I_ENV_INDEX];
        env_cnt_s = (int)state_i[FB_I_ENV_CNT];
        attack_state_s = (int)state_i[FB_I_ATTACK_STATE];
        gain_reduction0_s = state_d[FB_D_GAIN_REDUCTION0];
        gain_reduction1_s = state_d[FB_D_GAIN_REDUCTION1];
        if (parallel_unsafe_s && limiter_maybe_above_s > 0) limiter_maybe_above_s--;
    }
    __syncthreads();

    while (produced_s < output_frames && out_frame_s < total_frames) {
        if (c == 0U) {
            unsigned int nb = frames_per_window;
            if (nb > total_frames - out_frame_s) nb = total_frames - out_frame_s;
            if (nb > output_frames - produced_s) nb = output_frames - produced_s;
            nb_s = nb;
            skip_prefilled_s = (!parallel_unsafe_s && !first_s && state_i[FB_I_SKIP_SAFE_FILL] && state_i[FB_I_PREFILLED_OUTPUT] && state_i[FB_I_PREFILL_CHUNK_SAFE] && above_threshold_s != 0) ? 1 : 0;
            skip_feedback_s = (!first_s && state_i[FB_I_SKIP_SAFE_FEEDBACK] && above_threshold_s != 0) ? 1 : 0;
            if (!first_s && !skip_prefilled_s) {
                gain_s = gaussian_filter_dev(delta, weights, (delta_index_s + 10) < 30 ? (delta_index_s + 10) : (delta_index_s + 10 - 30));
                double gain_next = gaussian_filter_dev(delta, weights, (delta_index_s + 11) < 30 ? (delta_index_s + 11) : (delta_index_s + 11 - 30));
                gain_diff_s = gain_next - gain_s;
            } else {
                gain_s = 0.0;
                gain_diff_s = 0.0;
            }
        }
        __syncthreads();

        const unsigned int fill_write_index = write_index_s;
        const unsigned int fill_write_frame = write_frame_s;
        if (!first_s && !skip_prefilled_s) {
            for (unsigned int n = 0; n < nb_s; n++) {
                const unsigned int src_frame = fill_write_frame + n;
                double x = 0.0;
                if (src_frame < total_frames && src_frame >= input_base_frame && src_frame < input_base_frame + input_frames) {
                    x = input[((unsigned long long)(src_frame - input_base_frame) * (unsigned long long)channels) + c];
                } else if (src_frame < total_frames) {
                    state_i[FB_I_INPUT_MISSING] = 1;
                }
                const double timed_gain = gain_s + (((double)n / (double)nb_s) * gain_diff_s);
                const double v = (x * timed_gain) * offset_amp;
                if (v > ceiling || v < -ceiling) atomicMax((unsigned int *)&limiter_maybe_above_s, 3U);
                unsigned int dst_frame = fill_write_index + n;
                while (dst_frame >= limiter_lookahead_frames) dst_frame -= limiter_lookahead_frames;
                limiter_buf[((unsigned long long)dst_frame * (unsigned long long)channels) + c] = v;
            }
        }
        __syncthreads();

        if (c == 0U) {
            if (!first_s) {
                write_index_s += nb_s;
                while (write_index_s >= limiter_lookahead_frames) write_index_s -= limiter_lookahead_frames;
                write_frame_s += nb_s;
                if (nb_s < frames_per_window) {
                    write_index_s += frames_per_window - nb_s;
                    while (write_index_s >= limiter_lookahead_frames) write_index_s -= limiter_lookahead_frames;
                }
            }
            output_limiter_index_s = write_index_s;
        }
        __syncthreads();

        if (c == 0U) {
            parallel_unsafe_direct_s = (parallel_unsafe_s && limiter_maybe_above_s <= 0 && limiter_state_s == 0) ? 1 : 0;
        }
        __syncthreads();

        if (parallel_unsafe_direct_s && nb_s > 0U) {
            unsigned int prev_frame = output_limiter_index_s + attack_length + nb_s - 1U;
            while (prev_frame >= limiter_lookahead_frames) prev_frame -= limiter_lookahead_frames;
            prev_smp[c] = fabs(limiter_buf[((unsigned long long)prev_frame * (unsigned long long)channels) + c]);
        }
        __syncthreads();

        if (parallel_unsafe_s && !parallel_unsafe_direct_s && c == 0U) {
            true_peak_limiter_dev(
                limiter_buf, output, produced_s, nb_s, channels,
                limiter_lookahead_frames * channels, output_limiter_index_s * channels,
                attack_length, release_length, ceiling, frame_type_s, prev_smp,
                &limiter_state_s, &peak_index_s, &env_index_s, &env_cnt_s,
                &attack_state_s, &gain_reduction0_s, &gain_reduction1_s,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                limiter_maybe_above_s, skip_feedback_s ? 0 : 1, 0, 0, 0, 0, 0
            );
        }
        __syncthreads();

        if (skip_prefilled_s && !parallel_unsafe_s && nb_s > 0U) {
            prev_smp[c] = fabs(output[((unsigned long long)(produced_s + nb_s - 1U) * (unsigned long long)channels) + c]);
        } else if (!skip_prefilled_s && !parallel_unsafe_s) {
            unsigned int prev_frame = output_limiter_index_s + attack_length + nb_s - 1U;
            while (prev_frame >= limiter_lookahead_frames) prev_frame -= limiter_lookahead_frames;
            prev_smp[c] = fabs(limiter_buf[((unsigned long long)prev_frame * (unsigned long long)channels) + c]);
        }

        if (skip_feedback_s) {
            if (c == 0U) window_sum_s = 0.0;
            __syncthreads();
            if (!skip_prefilled_s) {
                for (unsigned int n = 0; n < nb_s; n++) {
                    unsigned int src_frame = output_limiter_index_s + n;
                    while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                    double out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
                    if (out > ceiling) out = ceiling;
                    else if (out < -ceiling) out = -ceiling;
                    output[((unsigned long long)(produced_s + n) * (unsigned long long)channels) + c] = out;
                }
            }
            __syncthreads();
        } else if (slot_accum_s) {
            if (c == 0U) {
                for (unsigned int s = 0; s < 5U; s++) slot_sum_s[s] = 0.0;
            }
            __syncthreads();
            double local_slot_sum = 0.0;
            for (unsigned int n = 0; n < nb_s; n++) {
                double out;
                if (parallel_unsafe_direct_s) {
                    unsigned int src_frame = output_limiter_index_s + n;
                    while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                    out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
                    if (out > ceiling) out = ceiling;
                    else if (out < -ceiling) out = -ceiling;
                    output[((unsigned long long)(produced_s + n) * (unsigned long long)channels) + c] = out;
                } else if (parallel_unsafe_s || skip_prefilled_s) {
                    out = output[((unsigned long long)(produced_s + n) * (unsigned long long)channels) + c];
                } else {
                    unsigned int src_frame = output_limiter_index_s + n;
                    while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                    out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
                    if (out > ceiling) out = ceiling;
                    else if (out < -ceiling) out = -ceiling;
                    output[((unsigned long long)(produced_s + n) * (unsigned long long)channels) + c] = out;
                }
                if (slot >= 0) {
                    const double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                    const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                    local_slot_sum += y * y * weight;
                    v4 = v3;
                    v3 = v2;
                    v2 = v1;
                    v1 = v0;
                }
            }
            if (slot >= 0) slot_sum_s[(unsigned int)slot] = local_slot_sum;
            __syncthreads();
            if (c == 0U) {
                double window_sum = 0.0;
                window_sum += slot_sum_s[0];
                window_sum += slot_sum_s[1];
                window_sum += slot_sum_s[2];
                window_sum += slot_sum_s[3];
                window_sum += slot_sum_s[4];
                window_sum_s = window_sum;
            }
            __syncthreads();
        } else if (window_accum_s) {
            if (c == 0U) window_sum_s = 0.0;
            __syncthreads();
            for (unsigned int tile_start = 0; tile_start < nb_s; tile_start += SAFE_FEEDBACK_TILE_FRAMES) {
                unsigned int tile_frames = nb_s - tile_start;
                if (tile_frames > SAFE_FEEDBACK_TILE_FRAMES) tile_frames = SAFE_FEEDBACK_TILE_FRAMES;
                if (c == 0U) {
                    for (unsigned int n = 0; n < tile_frames; n++) {
                        const unsigned int base = n * 5U;
                        for (unsigned int s = 0; s < 5U; s++) tile_energy_s[base + s] = 0.0;
                    }
                }
                __syncthreads();
                for (unsigned int n = 0; n < tile_frames; n++) {
                    const unsigned int local_n = tile_start + n;
                    double out;
                    if (parallel_unsafe_direct_s) {
                        unsigned int src_frame = output_limiter_index_s + local_n;
                        while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                        out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
                        if (out > ceiling) out = ceiling;
                        else if (out < -ceiling) out = -ceiling;
                        output[((unsigned long long)(produced_s + local_n) * (unsigned long long)channels) + c] = out;
                    } else if (parallel_unsafe_s || skip_prefilled_s) {
                        out = output[((unsigned long long)(produced_s + local_n) * (unsigned long long)channels) + c];
                    } else {
                        unsigned int src_frame = output_limiter_index_s + local_n;
                        while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                        out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
                        if (out > ceiling) out = ceiling;
                        else if (out < -ceiling) out = -ceiling;
                        output[((unsigned long long)(produced_s + local_n) * (unsigned long long)channels) + c] = out;
                    }
                    if (slot >= 0) {
                        const double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                        const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                        tile_energy_s[((unsigned int)n * 5U) + (unsigned int)slot] = y * y * weight;
                        v4 = v3;
                        v3 = v2;
                        v2 = v1;
                        v1 = v0;
                    }
                }
                __syncthreads();
                if (c == 0U) {
                    for (unsigned int n = 0; n < tile_frames; n++) {
                        const unsigned int base = n * 5U;
                        double frame_sum = 0.0;
                        frame_sum += tile_energy_s[base + 0];
                        frame_sum += tile_energy_s[base + 1];
                        frame_sum += tile_energy_s[base + 2];
                        frame_sum += tile_energy_s[base + 3];
                        frame_sum += tile_energy_s[base + 4];
                        window_sum_s += frame_sum;
                    }
                }
                __syncthreads();
            }
        } else {
            if (c == 0U) {
                for (unsigned int n = 0; n < nb_s; n++) {
                    const unsigned long long base = (unsigned long long)(produced_s + n) * 5ULL;
                    for (unsigned int s = 0; s < 5U; s++) frame_energy[base + s] = 0.0;
                }
            }
            __syncthreads();
            for (unsigned int n = 0; n < nb_s; n++) {
                double out;
                if (parallel_unsafe_direct_s) {
                    unsigned int src_frame = output_limiter_index_s + n;
                    while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                    out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
                    if (out > ceiling) out = ceiling;
                    else if (out < -ceiling) out = -ceiling;
                    output[((unsigned long long)(produced_s + n) * (unsigned long long)channels) + c] = out;
                } else if (parallel_unsafe_s || skip_prefilled_s) {
                    out = output[((unsigned long long)(produced_s + n) * (unsigned long long)channels) + c];
                } else {
                    unsigned int src_frame = output_limiter_index_s + n;
                    while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                    out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
                    if (out > ceiling) out = ceiling;
                    else if (out < -ceiling) out = -ceiling;
                    output[((unsigned long long)(produced_s + n) * (unsigned long long)channels) + c] = out;
                }
                if (slot >= 0) {
                    const double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                    const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                    frame_energy[((unsigned long long)(produced_s + n) * 5ULL) + (unsigned int)slot] = y * y * weight;
                    v4 = v3;
                    v3 = v2;
                    v2 = v1;
                    v1 = v0;
                }
            }
            __syncthreads();

            if (c == 0U) {
                double window_sum = 0.0;
                for (unsigned int n = 0; n < nb_s; n++) {
                    const unsigned long long base = (unsigned long long)(produced_s + n) * 5ULL;
                    double frame_sum = 0.0;
                    frame_sum += frame_energy[base + 0];
                    frame_sum += frame_energy[base + 1];
                    frame_sum += frame_energy[base + 2];
                    frame_sum += frame_energy[base + 3];
                    frame_sum += frame_energy[base + 4];
                    window_sum += frame_sum;
                }
                window_sum_s = window_sum;
            }
            __syncthreads();
        }

        if (c == 0U) {
            const double window_sum = window_sum_s;
            if (!skip_feedback_s) {
                out_window_sum_s += window_sum;
                out_window_count_s += nb_s;
                if (out_window_count_s == frames_per_window) {
                    if (out_short_count_s == 30) {
                        out_short_sum_s -= out_short_ring[out_short_index_s];
                    } else {
                        out_short_count_s++;
                    }
                    out_short_ring[out_short_index_s] = out_window_sum_s;
                    out_short_sum_s += out_window_sum_s;
                    out_short_index_s++;
                    if (out_short_index_s >= 30) out_short_index_s = 0;
                    out_window_sum_s = 0.0;
                    out_window_count_s = 0;
                }
            }
            out_frame_s += nb_s;
            produced_s += nb_s;
            frame_type_s = 1;
            if (first_s) {
                first_s = 0;
            } else {
                if (input_window_s < windows) {
                    double input_window_sum = window_sums[input_window_s];
                    double input_hist4_sum = 0.0;
                    double input_short_sum = 0.0;
                    if (source_precomputed) {
                        const unsigned long long source_base = (unsigned long long)input_window_s * 3ULL;
                        input_window_sum = source_channel_sums[source_base + 0ULL];
                        input_hist4_sum = input_window_s >= 3U ? source_channel_sums[source_base + 1ULL] : 0.0;
                        input_short_sum = source_channel_sums[source_base + 2ULL];
                    }
                    if (short_count_s == 30) {
                        short_sum_s -= short_ring[short_index_s];
                    } else {
                        short_count_s++;
                    }
                    short_ring[short_index_s] = input_window_sum;
                    short_sum_s += input_window_sum;
                    short_index_s++;
                    if (short_index_s >= 30) short_index_s = 0;
                    if (source_precomputed) short_sum_s = input_short_sum;
                    if (input_window_s >= 3) {
                        double e = (source_precomputed ? input_hist4_sum : (window_sums[input_window_s] + window_sums[input_window_s - 1] + window_sums[input_window_s - 2] + window_sums[input_window_s - 3])) / (double)(frames_per_window * 4U);
                        if (e >= hist_boundaries[0]) hist[hist_index_from_boundaries_dev(e, hist_boundaries)]++;
                    }
                }
                const double global = gated_loudness_lut_boundaries_dev(hist, hist_energies, hist_boundaries);
                const double shortterm = energy_to_loudness_dev(short_sum_s / (double)(frames_per_window * 30U));
                const double relative_threshold = relative_threshold_lut_dev(hist, hist_energies);
                if (above_threshold_s == 0) {
                    double shortterm_out = energy_to_loudness_dev(out_short_sum_s / (double)(frames_per_window * 30U));
                    if (shortterm > measured_thresh) prev_delta_s *= 1.0058;
                    if (shortterm_out >= target_i) above_threshold_s = 1;
                }
                if (shortterm < relative_threshold || shortterm <= -70.0 || above_threshold_s == 0) {
                    delta[delta_index_s] = prev_delta_s;
                } else {
                    double diff = isfinite(global) ? (shortterm - global) : 0.0;
                    double limit = target_lra / 2.0;
                    double env_global = fabs(diff) < limit ? diff : (diff < 0.0 ? -limit : limit);
                    double env_shortterm = target_i - shortterm;
                    delta[delta_index_s] = db_to_amp_dev(env_global + env_shortterm);
                }
                prev_delta_s = delta[delta_index_s];
                delta_index_s++;
                if (delta_index_s >= 30) delta_index_s = 0;
                input_window_s++;
            }
        }
        __syncthreads();
    }

    if (slot >= 0) {
        out_states[state_base + 0] = v1;
        out_states[state_base + 1] = v2;
        out_states[state_base + 2] = v3;
        out_states[state_base + 3] = v4;
    }
    __syncthreads();
    if (c == 0U) {
        state_i[FB_I_SHORT_INDEX] = short_index_s;
        state_i[FB_I_OUT_SHORT_INDEX] = (unsigned int)out_short_index_s;
        state_i[FB_I_SHORT_COUNT] = short_count_s;
        state_i[FB_I_OUT_SHORT_COUNT] = (unsigned int)out_short_count_s;
        state_i[FB_I_OUT_WINDOW_COUNT] = out_window_count_s;
        state_i[FB_I_DELTA_INDEX] = (unsigned int)delta_index_s;
        state_i[FB_I_ABOVE_THRESHOLD] = (unsigned int)above_threshold_s;
        state_i[FB_I_OUT_FRAME] = out_frame_s;
        state_i[FB_I_WRITE_FRAME] = write_frame_s;
        state_i[FB_I_WRITE_INDEX] = write_index_s;
        state_i[FB_I_INPUT_WINDOW] = input_window_s;
        state_i[FB_I_FRAME_TYPE] = (unsigned int)frame_type_s;
        state_i[FB_I_FIRST] = (unsigned int)first_s;
        state_i[FB_I_LIMITER_STATE] = (unsigned int)limiter_state_s;
        state_i[FB_I_PEAK_INDEX] = (unsigned int)peak_index_s;
        state_i[FB_I_ENV_INDEX] = (unsigned int)env_index_s;
        state_i[FB_I_ENV_CNT] = (unsigned int)env_cnt_s;
        state_i[FB_I_ATTACK_STATE] = (unsigned int)attack_state_s;
        state_i[FB_I_LIMITER_MAYBE_ABOVE_CEILING] = parallel_unsafe_s ? (unsigned int)limiter_maybe_above_s : 0;
        state_i[FB_I_SKIP_SAFE_FILL] = 0;
        state_i[FB_I_SKIP_SAFE_FEEDBACK] = 0;
        state_i[FB_I_FORCE_SAFE_IDLE] = 0;
        state_i[FB_I_SAFE_FEEDBACK_WINDOW_ACCUM] = 0;
        state_i[FB_I_SAFE_FEEDBACK_SLOT_ACCUM] = 0;
        state_i[FB_I_PARALLEL_UNSAFE_FEEDBACK] = 0;
        state_d[FB_D_SHORT_SUM] = short_sum_s;
        state_d[FB_D_OUT_SHORT_SUM] = out_short_sum_s;
        state_d[FB_D_OUT_WINDOW_SUM] = out_window_sum_s;
        state_d[FB_D_PREV_DELTA] = prev_delta_s;
        state_d[FB_D_GAIN_REDUCTION0] = gain_reduction0_s;
        state_d[FB_D_GAIN_REDUCTION1] = gain_reduction1_s;
    }
}

extern "C" __global__ void safe_feedback_skip_apply6_f64_kernel(
    const double *input,
    double *output,
    const double *window_sums,
    const double *hist_energies,
    const double *hist_boundaries,
    double *limiter_buf,
    double *prev_smp,
    unsigned int *state_i,
    double *state_d,
    unsigned int *hist,
    double *frame_energy,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int output_frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    unsigned int limiter_lookahead_frames,
    unsigned int attack_length,
    unsigned int release_length,
    const double *b,
    const double *a,
    double target_i,
    double target_lra,
    double measured_i,
    double measured_thresh,
    double offset_amp,
    double ceiling,
    const double *source_channel_sums,
    unsigned int source_faithful_stereo
) {
    if (blockIdx.x != 0 || (channels != 6U && channels != 2U)) return;
    const unsigned int tid = threadIdx.x;
    const unsigned int stride = blockDim.x;
    const int source_precomputed = (source_faithful_stereo >= 2U && channels == 2U && source_channel_sums);
    const int skip_limiter_lookahead_scan = ((source_faithful_stereo == 3U || source_faithful_stereo == 5U) && source_precomputed);
    const int source_fused_direct_feedback = (source_faithful_stereo >= 4U && source_precomputed);
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
    double *short_ring = state_d + FB_D_SHORT_RING;
    double *out_short_ring = state_d + FB_D_OUT_SHORT_RING;
    double *delta = state_d + FB_D_DELTA;
    double *out_states = state_d + FB_D_OUT_STATES;
    double *source_out_short_ring0 = state_d + FB_D_SOURCE_OUT_SHORT_RING0;
    double *source_out_short_ring1 = state_d + FB_D_SOURCE_OUT_SHORT_RING1;

    __shared__ unsigned int short_index_s;
    __shared__ unsigned int short_count_s;
    __shared__ unsigned int out_window_count_s;
    __shared__ unsigned int out_frame_s;
    __shared__ unsigned int write_frame_s;
    __shared__ unsigned int write_index_s;
    __shared__ unsigned int input_window_s;
    __shared__ unsigned int produced_s;
    __shared__ unsigned int nb_s;
    __shared__ unsigned int output_limiter_index_s;
    __shared__ unsigned int input_missing_s;
    __shared__ int out_short_index_s;
    __shared__ int out_short_count_s;
    __shared__ int delta_index_s;
    __shared__ int above_threshold_s;
    __shared__ int frame_type_s;
    __shared__ double short_sum_s;
    __shared__ double out_short_sum_s;
    __shared__ double out_window_sum_s;
    __shared__ double prev_delta_s;
    __shared__ double gain_s;
    __shared__ double gain_diff_s;
    __shared__ unsigned int limiter_maybe_above_s;
    __shared__ int use_limiter_s;
    __shared__ int limiter_state_s;
    __shared__ int peak_index_s;
    __shared__ int env_index_s;
    __shared__ int env_cnt_s;
    __shared__ int attack_state_s;
    __shared__ double gain_reduction0_s;
    __shared__ double gain_reduction1_s;
    __shared__ double source_out_window_sum0_s;
    __shared__ double source_out_window_sum1_s;
    __shared__ double source_feedback_sum_s[2];

    if (tid == 0U) {
        short_index_s = state_i[FB_I_SHORT_INDEX];
        short_count_s = state_i[FB_I_SHORT_COUNT];
        out_window_count_s = state_i[FB_I_OUT_WINDOW_COUNT];
        out_frame_s = state_i[FB_I_OUT_FRAME];
        write_frame_s = state_i[FB_I_WRITE_FRAME];
        write_index_s = state_i[FB_I_WRITE_INDEX];
        input_window_s = state_i[FB_I_INPUT_WINDOW];
        produced_s = 0U;
        input_missing_s = 0U;
        out_short_index_s = (int)state_i[FB_I_OUT_SHORT_INDEX];
        out_short_count_s = (int)state_i[FB_I_OUT_SHORT_COUNT];
        delta_index_s = (int)state_i[FB_I_DELTA_INDEX];
        above_threshold_s = (int)state_i[FB_I_ABOVE_THRESHOLD];
        frame_type_s = (int)state_i[FB_I_FRAME_TYPE];
        short_sum_s = state_d[FB_D_SHORT_SUM];
        out_short_sum_s = state_d[FB_D_OUT_SHORT_SUM];
        out_window_sum_s = state_d[FB_D_OUT_WINDOW_SUM];
        prev_delta_s = state_d[FB_D_PREV_DELTA];
        limiter_maybe_above_s = state_i[FB_I_LIMITER_MAYBE_ABOVE_CEILING];
        use_limiter_s = 0;
        limiter_state_s = (int)state_i[FB_I_LIMITER_STATE];
        peak_index_s = (int)state_i[FB_I_PEAK_INDEX];
        env_index_s = (int)state_i[FB_I_ENV_INDEX];
        env_cnt_s = (int)state_i[FB_I_ENV_CNT];
        attack_state_s = (int)state_i[FB_I_ATTACK_STATE];
        gain_reduction0_s = state_d[FB_D_GAIN_REDUCTION0];
        gain_reduction1_s = state_d[FB_D_GAIN_REDUCTION1];
        source_out_window_sum0_s = state_d[FB_D_SOURCE_OUT_WINDOW_SUM0];
        source_out_window_sum1_s = state_d[FB_D_SOURCE_OUT_WINDOW_SUM1];
    }
    __syncthreads();

    double out_v1 = 0.0;
    double out_v2 = 0.0;
    double out_v3 = 0.0;
    double out_v4 = 0.0;
    if (source_precomputed && tid < 2U) {
        const unsigned int state_base = tid * 4U;
        out_v1 = out_states[state_base + 0U];
        out_v2 = out_states[state_base + 1U];
        out_v3 = out_states[state_base + 2U];
        out_v4 = out_states[state_base + 3U];
    }

    while (produced_s < output_frames && out_frame_s < total_frames) {
        if (tid == 0U) {
            unsigned int nb = frames_per_window;
            if (nb > total_frames - out_frame_s) nb = total_frames - out_frame_s;
            if (nb > output_frames - produced_s) nb = output_frames - produced_s;
            nb_s = nb;
            gain_s = gaussian_filter_dev(delta, weights, (delta_index_s + 10) < 30 ? (delta_index_s + 10) : (delta_index_s + 10 - 30));
            double gain_next = gaussian_filter_dev(delta, weights, (delta_index_s + 11) < 30 ? (delta_index_s + 11) : (delta_index_s + 11 - 30));
            gain_diff_s = gain_next - gain_s;
        }
        __syncthreads();

        const unsigned int fill_write_index = write_index_s;
        const unsigned int fill_write_frame = write_frame_s;
        const unsigned int fill_samples = nb_s * channels;
        for (unsigned int idx = tid; idx < fill_samples; idx += stride) {
            const unsigned int n = idx / channels;
            const unsigned int c = idx - (n * channels);
            const unsigned int src_frame = fill_write_frame + n;
            double x = 0.0;
            if (src_frame < total_frames && src_frame >= input_base_frame && src_frame < input_base_frame + input_frames) {
                x = input[((unsigned long long)(src_frame - input_base_frame) * (unsigned long long)channels) + c];
            } else if (src_frame < total_frames) {
                atomicExch(&input_missing_s, 1U);
            }
            const double gain_pos = __ddiv_rn((double)n, (double)nb_s);
            const double timed_gain = __dadd_rn(gain_s, __dmul_rn(gain_pos, gain_diff_s));
            const double v = __dmul_rn(__dmul_rn(x, timed_gain), offset_amp);
            if (v > ceiling || v < -ceiling) atomicMax(&limiter_maybe_above_s, 3U);
            unsigned int dst_frame = fill_write_index + n;
            while (dst_frame >= limiter_lookahead_frames) dst_frame -= limiter_lookahead_frames;
            limiter_buf[((unsigned long long)dst_frame * (unsigned long long)channels) + c] = v;
        }
        __syncthreads();

        if (tid == 0U) {
            write_index_s += nb_s;
            while (write_index_s >= limiter_lookahead_frames) write_index_s -= limiter_lookahead_frames;
            write_frame_s += nb_s;
            if (nb_s < frames_per_window) {
                write_index_s += frames_per_window - nb_s;
                while (write_index_s >= limiter_lookahead_frames) write_index_s -= limiter_lookahead_frames;
            }
            output_limiter_index_s = write_index_s;
        }
        __syncthreads();

        if (!skip_limiter_lookahead_scan) {
            for (unsigned int idx = tid; idx < fill_samples; idx += stride) {
                const unsigned int n = idx / channels;
                const unsigned int c = idx - (n * channels);
                unsigned int src_frame = output_limiter_index_s + attack_length + n;
                while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                const double out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
                if (out > ceiling || out < -ceiling) atomicMax(&limiter_maybe_above_s, 3U);
            }
            __syncthreads();
        }

        if (tid == 0U) {
            use_limiter_s = (limiter_maybe_above_s > 0U || limiter_state_s != 0) ? 1 : 0;
        }
        __syncthreads();

        if (use_limiter_s && tid == 0U) {
            true_peak_limiter_dev(
                limiter_buf, output, produced_s, nb_s, channels,
                limiter_lookahead_frames * channels, output_limiter_index_s * channels,
                attack_length, release_length, ceiling, frame_type_s, prev_smp,
                &limiter_state_s, &peak_index_s, &env_index_s, &env_cnt_s,
                &attack_state_s, &gain_reduction0_s, &gain_reduction1_s,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                (int)limiter_maybe_above_s, 1, 0, 0, 0, 0, 0
            );
        }
        __syncthreads();

        if (!use_limiter_s && tid < channels && nb_s > 0U) {
            unsigned int prev_frame = output_limiter_index_s + attack_length + nb_s - 1U;
            while (prev_frame >= limiter_lookahead_frames) prev_frame -= limiter_lookahead_frames;
            prev_smp[tid] = fabs(limiter_buf[((unsigned long long)prev_frame * (unsigned long long)channels) + tid]);
        }

        const int fused_direct_feedback_s = (!use_limiter_s && source_fused_direct_feedback && above_threshold_s == 0 && nb_s > 0U);

        if (!use_limiter_s) for (unsigned int idx = tid; idx < fill_samples; idx += stride) {
            const unsigned int n = idx / channels;
            const unsigned int c = idx - (n * channels);
            unsigned int src_frame = output_limiter_index_s + n;
            while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
            double out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
            if (out > ceiling) out = ceiling;
            else if (out < -ceiling) out = -ceiling;
            output[((unsigned long long)(produced_s + n) * (unsigned long long)channels) + c] = out;
        }
        __syncthreads();

        if (source_precomputed && above_threshold_s == 0) {
            if (tid < 2U) {
                double local_source_sum = 0.0;
                for (unsigned int n = 0; n < nb_s; n++) {
                    double out;
                    if (fused_direct_feedback_s) {
                        unsigned int src_frame = output_limiter_index_s + n;
                        while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                        out = limiter_buf[((unsigned long long)src_frame * 2ULL) + tid];
                        if (out > ceiling) out = ceiling;
                        else if (out < -ceiling) out = -ceiling;
                    } else {
                        out = output[((unsigned long long)(produced_s + n) * 2ULL) + tid];
                    }
                    const double v0 = kweight_v0_rn_dev(out, a, out_v1, out_v2, out_v3, out_v4);
                    const double y = kweight_y_rn_dev(b, v0, out_v1, out_v2, out_v3, out_v4);
                    local_source_sum += y * y;
                    out_v4 = out_v3;
                    out_v3 = out_v2;
                    out_v2 = out_v1;
                    out_v1 = v0;
                }
                source_feedback_sum_s[tid] = local_source_sum;
            }
            __syncthreads();
            if (tid == 0U) {
                source_out_window_sum0_s += source_feedback_sum_s[0];
                source_out_window_sum1_s += source_feedback_sum_s[1];
                out_window_sum_s = source_out_window_sum0_s + source_out_window_sum1_s;
                out_window_count_s += nb_s;
                if (out_window_count_s == frames_per_window) {
                    if (out_short_count_s < 30) out_short_count_s++;
                    source_out_short_ring0[out_short_index_s] = source_out_window_sum0_s;
                    source_out_short_ring1[out_short_index_s] = source_out_window_sum1_s;
                    out_short_ring[out_short_index_s] = source_out_window_sum0_s + source_out_window_sum1_s;
                    out_short_sum_s = source_stereo_recompute_short_sum_dev(source_out_short_ring0, source_out_short_ring1);
                    out_short_index_s++;
                    if (out_short_index_s >= 30) out_short_index_s = 0;
                    source_out_window_sum0_s = 0.0;
                    source_out_window_sum1_s = 0.0;
                    out_window_sum_s = 0.0;
                    out_window_count_s = 0;
                }
            }
            __syncthreads();
        }

        if (tid == 0U && limiter_maybe_above_s > 0U) limiter_maybe_above_s--;
        __syncthreads();

        if (tid == 0U) {
            out_frame_s += nb_s;
            produced_s += nb_s;
            frame_type_s = 1;

            if (input_window_s < windows) {
                double input_window_sum = window_sums[input_window_s];
                double input_hist4_sum = 0.0;
                double input_short_sum = 0.0;
                if (source_precomputed) {
                    const unsigned long long source_base = (unsigned long long)input_window_s * 3ULL;
                    input_window_sum = source_channel_sums[source_base + 0ULL];
                    input_hist4_sum = input_window_s >= 3U ? source_channel_sums[source_base + 1ULL] : 0.0;
                    input_short_sum = source_channel_sums[source_base + 2ULL];
                }
                if (short_count_s == 30) {
                    short_sum_s -= short_ring[short_index_s];
                } else {
                    short_count_s++;
                }
                short_ring[short_index_s] = input_window_sum;
                short_sum_s += input_window_sum;
                short_index_s++;
                if (short_index_s >= 30) short_index_s = 0;
                if (source_precomputed) short_sum_s = input_short_sum;
                if (input_window_s >= 3) {
                    double e = (source_precomputed ? input_hist4_sum : (window_sums[input_window_s] + window_sums[input_window_s - 1] + window_sums[input_window_s - 2] + window_sums[input_window_s - 3])) / (double)(frames_per_window * 4U);
                    if (e >= hist_boundaries[0]) hist[hist_index_from_boundaries_dev(e, hist_boundaries)]++;
                }
            }
            const double global = gated_loudness_lut_boundaries_dev(hist, hist_energies, hist_boundaries);
            const double shortterm = energy_to_loudness_dev(short_sum_s / (double)(frames_per_window * 30U));
            const double relative_threshold = relative_threshold_lut_dev(hist, hist_energies);
            if (above_threshold_s == 0) {
                double shortterm_out = energy_to_loudness_dev(out_short_sum_s / (double)(frames_per_window * 30U));
                if (shortterm > measured_thresh) prev_delta_s *= 1.0058;
                if (shortterm_out >= target_i) above_threshold_s = 1;
            }
            if (shortterm < relative_threshold || shortterm <= -70.0 || above_threshold_s == 0) {
                delta[delta_index_s] = prev_delta_s;
            } else {
                double diff = isfinite(global) ? (shortterm - global) : 0.0;
                double limit = target_lra / 2.0;
                double env_global = fabs(diff) < limit ? diff : (diff < 0.0 ? -limit : limit);
                double env_shortterm = target_i - shortterm;
                delta[delta_index_s] = db_to_amp_dev(env_global + env_shortterm);
            }
            prev_delta_s = delta[delta_index_s];
            delta_index_s++;
            if (delta_index_s >= 30) delta_index_s = 0;
            input_window_s++;
        }
        __syncthreads();
    }

    if (source_precomputed && tid < 2U) {
        const unsigned int state_base = tid * 4U;
        out_states[state_base + 0U] = out_v1;
        out_states[state_base + 1U] = out_v2;
        out_states[state_base + 2U] = out_v3;
        out_states[state_base + 3U] = out_v4;
    }
    __syncthreads();

    if (tid == 0U) {
        if (input_missing_s) state_i[FB_I_INPUT_MISSING] = 1;
        state_i[FB_I_SHORT_INDEX] = short_index_s;
        state_i[FB_I_OUT_SHORT_INDEX] = (unsigned int)out_short_index_s;
        state_i[FB_I_SHORT_COUNT] = short_count_s;
        state_i[FB_I_OUT_SHORT_COUNT] = (unsigned int)out_short_count_s;
        state_i[FB_I_OUT_WINDOW_COUNT] = out_window_count_s;
        state_i[FB_I_DELTA_INDEX] = (unsigned int)delta_index_s;
        state_i[FB_I_ABOVE_THRESHOLD] = (unsigned int)above_threshold_s;
        state_i[FB_I_OUT_FRAME] = out_frame_s;
        state_i[FB_I_WRITE_FRAME] = write_frame_s;
        state_i[FB_I_WRITE_INDEX] = write_index_s;
        state_i[FB_I_INPUT_WINDOW] = input_window_s;
        state_i[FB_I_FRAME_TYPE] = (unsigned int)frame_type_s;
        state_i[FB_I_LIMITER_STATE] = (unsigned int)limiter_state_s;
        state_i[FB_I_PEAK_INDEX] = (unsigned int)peak_index_s;
        state_i[FB_I_ENV_INDEX] = (unsigned int)env_index_s;
        state_i[FB_I_ENV_CNT] = (unsigned int)env_cnt_s;
        state_i[FB_I_ATTACK_STATE] = (unsigned int)attack_state_s;
        state_i[FB_I_LIMITER_MAYBE_ABOVE_CEILING] = limiter_maybe_above_s;
        state_i[FB_I_SKIP_SAFE_FILL] = 0;
        state_i[FB_I_SKIP_SAFE_FEEDBACK] = 0;
        state_i[FB_I_FORCE_SAFE_IDLE] = 0;
        state_i[FB_I_SAFE_FEEDBACK_WINDOW_ACCUM] = 0;
        state_i[FB_I_SAFE_FEEDBACK_SLOT_ACCUM] = 0;
        state_i[FB_I_PARALLEL_UNSAFE_FEEDBACK] = 0;
        state_d[FB_D_SHORT_SUM] = short_sum_s;
        state_d[FB_D_OUT_SHORT_SUM] = out_short_sum_s;
        state_d[FB_D_OUT_WINDOW_SUM] = out_window_sum_s;
        state_d[FB_D_PREV_DELTA] = prev_delta_s;
        state_d[FB_D_GAIN_REDUCTION0] = gain_reduction0_s;
        state_d[FB_D_GAIN_REDUCTION1] = gain_reduction1_s;
        state_d[FB_D_SOURCE_OUT_WINDOW_SUM0] = source_out_window_sum0_s;
        state_d[FB_D_SOURCE_OUT_WINDOW_SUM1] = source_out_window_sum1_s;
    }
}

extern "C" __device__ double feedback_input_sample_dev(
    const double *input,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int total_frames,
    unsigned int frame,
    unsigned int c,
    unsigned int channels,
    unsigned int *state_i,
    double *profile_counts
) {
    if (frame >= total_frames) {
        if (profile_counts) profile_counts[FB_D_COUNT_INPUT_ZEROS] += 1.0;
        return 0.0;
    }
    if (frame < input_base_frame || frame >= input_base_frame + input_frames) {
        state_i[FB_I_INPUT_MISSING] = 1;
        if (profile_counts) profile_counts[FB_D_COUNT_INPUT_ZEROS] += 1.0;
        return 0.0;
    }
    if (profile_counts) profile_counts[FB_D_COUNT_INPUT_READS] += 1.0;
    return input[((unsigned long long)(frame - input_base_frame) * channels) + c];
}

extern "C" __device__ void source_input_ring_write_frame_dev(
    const double *input,
    double *source_short_ring,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int total_frames,
    unsigned int frame,
    unsigned int channels,
    unsigned int frames_per_window,
    const double *b,
    const double *a,
    double *source_in_state0,
    double *source_in_state1,
    unsigned int *state_i,
    double *profile_counts
) {
    const unsigned int ring_frames = frames_per_window * 30U;
    const unsigned int ring_frame = ring_frames ? (frame % ring_frames) : 0U;
    double *states[2] = {source_in_state0, source_in_state1};
    for (unsigned int c = 0; c < 2U; c++) {
        double *st = states[c];
        const double x = feedback_input_sample_dev(input, input_base_frame, input_frames, total_frames, frame, c, channels, state_i, profile_counts);
        const double v0 = kweight_v0_rn_dev(x, a, st[0], st[1], st[2], st[3]);
        const double y = kweight_y_rn_dev(b, v0, st[0], st[1], st[2], st[3]);
        source_short_ring[((unsigned long long)ring_frame * 2ULL) + c] = y * y;
        st[3] = st[2];
        st[2] = st[1];
        st[1] = st[0];
        st[0] = v0;
    }
}

extern "C" __device__ void source_input_ring_write_window_dev(
    const double *input,
    double *source_short_ring,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int total_frames,
    unsigned int start_frame,
    unsigned int frames_per_window,
    const double *b,
    const double *a,
    double *source_in_state0,
    double *source_in_state1,
    unsigned int *state_i,
    double *profile_counts
) {
    for (unsigned int n = 0; n < frames_per_window; n++) {
        source_input_ring_write_frame_dev(input, source_short_ring, input_base_frame, input_frames, total_frames, start_frame + n, 2U, frames_per_window, b, a, source_in_state0, source_in_state1, state_i, profile_counts);
    }
}

extern "C" __device__ double source_input_ring_sum_dev(
    const double *source_short_ring,
    unsigned int end_window,
    unsigned int count,
    unsigned int frames_per_window
) {
    const unsigned int ring_frames = frames_per_window * 30U;
    if (!source_short_ring || ring_frames == 0U || count == 0U) return 0.0;
    if (count > 30U) count = 30U;
    const unsigned int end_frame = end_window * frames_per_window;
    const unsigned int start_frame = end_frame - (count * frames_per_window);
    double total = 0.0;
    for (unsigned int c = 0; c < 2U; c++) {
        double channel_sum = 0.0;
        for (unsigned int frame = start_frame; frame < end_frame; frame++) {
            const unsigned int ring_frame = frame % ring_frames;
            channel_sum += source_short_ring[((unsigned long long)ring_frame * 2ULL) + c];
        }
        total += channel_sum;
    }
    return total;
}

extern "C" __device__ double source_precomputed_sum_dev(
    const double *source_exact_sums,
    unsigned int window,
    unsigned int slot,
    unsigned int windows
) {
    if (!source_exact_sums || window >= windows || slot >= 3U) return 0.0;
    return source_exact_sums[((unsigned long long)window * 3ULL) + slot];
}

extern "C" __global__ void source_stereo_energy_f64_kernel(
    const double *input,
    double *source_energy,
    const double *source_start_states,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int channels,
    unsigned int frames_per_window,
    const double *b,
    const double *a
) {
    const unsigned int c = blockIdx.x & 1U;
    const unsigned int local_window = blockIdx.x >> 1U;
    if (threadIdx.x != 0U || channels != 2U || !source_energy || !source_start_states || frames_per_window == 0U) return;
    const unsigned int start_window = input_base_frame / frames_per_window;
    const unsigned int window_frame_start = local_window * frames_per_window;
    if (window_frame_start >= input_frames) return;
    const unsigned int window_frames_left = input_frames - window_frame_start;
    const unsigned int window_frames = window_frames_left < frames_per_window ? window_frames_left : frames_per_window;
    const unsigned long long state_base = ((unsigned long long)(start_window + local_window) * 2ULL + c) * 4ULL;
    double v1 = source_start_states[state_base + 0];
    double v2 = source_start_states[state_base + 1];
    double v3 = source_start_states[state_base + 2];
    double v4 = source_start_states[state_base + 3];
    for (unsigned int i = 0; i < window_frames; i++) {
        const unsigned int n = window_frame_start + i;
        const unsigned int frame = input_base_frame + n;
        const double x = frame < total_frames ? input[((unsigned long long)n * 2ULL) + c] : 0.0;
        const double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
        const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
        source_energy[((unsigned long long)n * 2ULL) + c] = y * y;
        v4 = v3;
        v3 = v2;
        v2 = v1;
        v1 = v0;
    }
}

extern "C" __global__ void source_stereo_energy_packed_f64_kernel(
    const double *input,
    double *source_energy,
    const double *source_start_states,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int channels,
    unsigned int frames_per_window,
    const double *b,
    const double *a
) {
    if (channels != 2U || !source_energy || !source_start_states || frames_per_window == 0U) return;
    const unsigned int energy_windows = (input_frames + frames_per_window - 1U) / frames_per_window;
    const unsigned int total_pairs = energy_windows * 2U;
    const unsigned int stride = blockDim.x * gridDim.x;
    const unsigned int start_window = input_base_frame / frames_per_window;
    for (unsigned int pair = blockIdx.x * blockDim.x + threadIdx.x; pair < total_pairs; pair += stride) {
        const unsigned int c = pair & 1U;
        const unsigned int local_window = pair >> 1U;
        const unsigned int window_frame_start = local_window * frames_per_window;
        if (window_frame_start >= input_frames) continue;
        const unsigned int window_frames_left = input_frames - window_frame_start;
        const unsigned int window_frames = window_frames_left < frames_per_window ? window_frames_left : frames_per_window;
        const unsigned long long state_base = ((unsigned long long)(start_window + local_window) * 2ULL + c) * 4ULL;
        double v1 = source_start_states[state_base + 0];
        double v2 = source_start_states[state_base + 1];
        double v3 = source_start_states[state_base + 2];
        double v4 = source_start_states[state_base + 3];
        for (unsigned int i = 0; i < window_frames; i++) {
            const unsigned int n = window_frame_start + i;
            const unsigned int frame = input_base_frame + n;
            const double x = frame < total_frames ? input[((unsigned long long)n * 2ULL) + c] : 0.0;
            const double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
            const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
            source_energy[((unsigned long long)n * 2ULL) + c] = y * y;
            v4 = v3;
            v3 = v2;
            v2 = v1;
            v1 = v0;
        }
    }
}

extern "C" __global__ void source_stereo_energy_packed_hoist_f64_kernel(
    const double *input,
    double *source_energy,
    const double *source_start_states,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int channels,
    unsigned int frames_per_window,
    const double *b,
    const double *a
) {
    if (channels != 2U || !source_energy || !source_start_states || frames_per_window == 0U) return;
    const double a1 = a[1];
    const double a2 = a[2];
    const double a3 = a[3];
    const double a4 = a[4];
    const double b0 = b[0];
    const double b1 = b[1];
    const double b2 = b[2];
    const double b3 = b[3];
    const double b4 = b[4];
    const unsigned int energy_windows = (input_frames + frames_per_window - 1U) / frames_per_window;
    const unsigned int total_pairs = energy_windows * 2U;
    const unsigned int stride = blockDim.x * gridDim.x;
    const unsigned int start_window = input_base_frame / frames_per_window;
    for (unsigned int pair = blockIdx.x * blockDim.x + threadIdx.x; pair < total_pairs; pair += stride) {
        const unsigned int c = pair & 1U;
        const unsigned int local_window = pair >> 1U;
        const unsigned int window_frame_start = local_window * frames_per_window;
        if (window_frame_start >= input_frames) continue;
        const unsigned int window_frames_left = input_frames - window_frame_start;
        const unsigned int window_frames = window_frames_left < frames_per_window ? window_frames_left : frames_per_window;
        const unsigned long long state_base = ((unsigned long long)(start_window + local_window) * 2ULL + c) * 4ULL;
        double v1 = source_start_states[state_base + 0];
        double v2 = source_start_states[state_base + 1];
        double v3 = source_start_states[state_base + 2];
        double v4 = source_start_states[state_base + 3];
        for (unsigned int i = 0; i < window_frames; i++) {
            const unsigned int n = window_frame_start + i;
            const unsigned int frame = input_base_frame + n;
            const double x = frame < total_frames ? input[((unsigned long long)n * 2ULL) + c] : 0.0;
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
            source_energy[((unsigned long long)n * 2ULL) + c] = y * y;
            v4 = v3;
            v3 = v2;
            v2 = v1;
            v1 = v0;
        }
    }
}

extern "C" __global__ void source_stereo_block_sums_f64_kernel(
    const double *source_energy,
    double *source_block_sums,
    unsigned int input_frames,
    unsigned int channels,
    unsigned int block_frames
) {
    if (channels != 2U || !source_energy || !source_block_sums || block_frames == 0U) return;
    const unsigned int block_count = (input_frames + block_frames - 1U) / block_frames;
    const unsigned int total_pairs = block_count * 2U;
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int pair = blockIdx.x * blockDim.x + threadIdx.x; pair < total_pairs; pair += stride) {
        const unsigned int c = pair & 1U;
        const unsigned int block = pair >> 1U;
        const unsigned int start_frame = block * block_frames;
        unsigned int end_frame = start_frame + block_frames;
        if (end_frame > input_frames || end_frame < start_frame) end_frame = input_frames;
        double sum = 0.0;
        for (unsigned int frame = start_frame; frame < end_frame; frame++) {
            sum += source_energy[((unsigned long long)frame * 2ULL) + c];
        }
        source_block_sums[((unsigned long long)(block + 1U) * 2ULL) + c] = sum;
    }
}

extern "C" __global__ void source_stereo_block_prefix_sums_f64_kernel(
    double *source_block_sums,
    unsigned int block_count,
    unsigned int channels
) {
    const unsigned int c = blockIdx.x;
    if (threadIdx.x != 0U || c >= 2U || channels != 2U || !source_block_sums) return;
    double running = 0.0;
    source_block_sums[c] = 0.0;
    for (unsigned int block = 0; block < block_count; block++) {
        const unsigned long long idx = ((unsigned long long)(block + 1U) * 2ULL) + c;
        running += source_block_sums[idx];
        source_block_sums[idx] = running;
    }
}

static __device__ double source_stereo_block_range_sum_f64_dev(
    const double *source_energy,
    const double *source_block_sums,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int block_frames,
    unsigned int start_frame,
    unsigned int end_frame,
    unsigned int c
) {
    if (block_frames == 0U || end_frame <= start_frame) return 0.0;
    if (start_frame < input_base_frame) start_frame = input_base_frame;
    const unsigned int input_end_frame = input_base_frame + input_frames;
    if (end_frame > input_end_frame || end_frame < start_frame) end_frame = input_end_frame;
    if (end_frame > total_frames) end_frame = total_frames;
    if (end_frame <= start_frame) return 0.0;

    const unsigned int local_start = start_frame - input_base_frame;
    const unsigned int local_end = end_frame - input_base_frame;
    unsigned int first_full_block = (local_start + block_frames - 1U) / block_frames;
    unsigned int last_full_block = local_end / block_frames;
    if (last_full_block < first_full_block) last_full_block = first_full_block;

    double sum = 0.0;
    unsigned int edge_end = first_full_block * block_frames;
    if (edge_end > local_end || edge_end < local_start) edge_end = local_end;
    for (unsigned int frame = local_start; frame < edge_end; frame++) {
        sum += source_energy[((unsigned long long)frame * 2ULL) + c];
    }
    if (last_full_block > first_full_block) {
        sum += source_block_sums[((unsigned long long)last_full_block * 2ULL) + c] - source_block_sums[((unsigned long long)first_full_block * 2ULL) + c];
    }
    unsigned int tail_start = last_full_block * block_frames;
    if (tail_start < edge_end) tail_start = edge_end;
    for (unsigned int frame = tail_start; frame < local_end; frame++) {
        sum += source_energy[((unsigned long long)frame * 2ULL) + c];
    }
    return sum;
}

extern "C" __global__ void source_stereo_block_exact_sums_f64_kernel(
    const double *source_energy,
    const double *source_block_sums,
    double *source_exact_sums,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int target_start_window,
    unsigned int target_windows,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    unsigned int block_frames
) {
    if (channels != 2U || !source_energy || !source_block_sums || !source_exact_sums || frames_per_window == 0U || block_frames == 0U) return;
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int local = blockIdx.x * blockDim.x + threadIdx.x; local < target_windows; local += stride) {
        const unsigned int t = target_start_window + local;
        if (t >= windows) continue;
        const unsigned int end_window = t + 1U;
        const unsigned int short_count = end_window < 30U ? end_window : 30U;
        const unsigned int short_start_window = end_window - short_count;
        const unsigned int hist_start_window = end_window >= 4U ? end_window - 4U : end_window;
        const unsigned int window_start_frame = t * frames_per_window;
        const unsigned int hist_start_frame = hist_start_window * frames_per_window;
        const unsigned int start_frame = short_start_window * frames_per_window;
        unsigned int end_frame = end_window * frames_per_window;
        if (end_frame > total_frames || end_frame < start_frame) end_frame = total_frames;

        double short_total = 0.0;
        double hist4_total = 0.0;
        double window_total = 0.0;
        for (unsigned int c = 0; c < 2U; c++) {
            const double channel_short = source_stereo_block_range_sum_f64_dev(source_energy, source_block_sums, total_frames, input_base_frame, input_frames, block_frames, start_frame, end_frame, c);
            const double channel_hist4 = source_stereo_block_range_sum_f64_dev(source_energy, source_block_sums, total_frames, input_base_frame, input_frames, block_frames, hist_start_frame, end_frame, c);
            const double channel_window = source_stereo_block_range_sum_f64_dev(source_energy, source_block_sums, total_frames, input_base_frame, input_frames, block_frames, window_start_frame, end_frame, c);
            short_total += channel_short;
            hist4_total += channel_hist4;
            window_total += channel_window;
        }
        const unsigned long long out_base = (unsigned long long)t * 3ULL;
        source_exact_sums[out_base + 0] = window_total;
        source_exact_sums[out_base + 1] = end_window >= 4U ? hist4_total : 0.0;
        source_exact_sums[out_base + 2] = short_total;
    }
}

extern "C" __global__ void source_stereo_exact_sums_f64_kernel(
    const double *source_energy,
    double *source_exact_sums,
    const double *source_start_states,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int target_start_window,
    unsigned int target_windows,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    const double *b,
    const double *a
) {
    if (channels != 2U || !source_energy || !source_exact_sums || frames_per_window == 0U) return;
    __shared__ double channel_sums[128U * 3U];
    const unsigned int lane = blockIdx.x * blockDim.x + threadIdx.x;
    const unsigned int local = lane >> 1U;
    const unsigned int c = lane & 1U;
    double channel_short = 0.0;
    double channel_hist4 = 0.0;
    double channel_window = 0.0;
    unsigned int t = windows;
    unsigned int end_window = 0U;
    if (local < target_windows) {
        t = target_start_window + local;
        if (t < windows) {
            end_window = t + 1U;
            const unsigned int short_count = end_window < 30U ? end_window : 30U;
            const unsigned int short_start_window = end_window - short_count;
            const unsigned int hist_start_window = end_window >= 4U ? end_window - 4U : end_window;
            const unsigned int window_start_frame = t * frames_per_window;
            const unsigned int hist_start_frame = hist_start_window * frames_per_window;
            const unsigned int start_frame = short_start_window * frames_per_window;
            unsigned int end_frame = end_window * frames_per_window;
            if (end_frame > total_frames || end_frame < start_frame) end_frame = total_frames;
            for (unsigned int frame = start_frame; frame < end_frame; frame++) {
                if (frame >= input_base_frame && frame < input_base_frame + input_frames) {
                    const double energy = source_energy[((unsigned long long)(frame - input_base_frame) * 2ULL) + c];
                    channel_short += energy;
                    if (frame >= hist_start_frame) channel_hist4 += energy;
                    if (frame >= window_start_frame) channel_window += energy;
                }
            }
        }
    }
    const unsigned int shared_base = threadIdx.x * 3U;
    channel_sums[shared_base + 0U] = channel_window;
    channel_sums[shared_base + 1U] = channel_hist4;
    channel_sums[shared_base + 2U] = channel_short;
    __syncthreads();
    if ((threadIdx.x & 1U) == 0U && local < target_windows && t < windows) {
        const unsigned int shared_next = shared_base + 3U;
        const double window_total = channel_sums[shared_base + 0U] + channel_sums[shared_next + 0U];
        const double hist4_total = channel_sums[shared_base + 1U] + channel_sums[shared_next + 1U];
        const double short_total = channel_sums[shared_base + 2U] + channel_sums[shared_next + 2U];
        const unsigned long long out_base = (unsigned long long)t * 3ULL;
        source_exact_sums[out_base + 0] = window_total;
        source_exact_sums[out_base + 1] = end_window >= 4U ? hist4_total : 0.0;
        source_exact_sums[out_base + 2] = short_total;
    }
}

extern "C" __global__ void source_stereo_exact_sums_split_f64_kernel(
    const double *source_energy,
    double *source_exact_sums,
    const double *source_start_states,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int target_start_window,
    unsigned int target_windows,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    const double *b,
    const double *a
) {
    if (channels != 2U || !source_energy || !source_exact_sums || frames_per_window == 0U) return;
    __shared__ double channel_sums[128U * 3U];
    const unsigned int lane = blockIdx.x * blockDim.x + threadIdx.x;
    const unsigned int local = lane >> 1U;
    const unsigned int c = lane & 1U;
    double channel_short = 0.0;
    double channel_hist4 = 0.0;
    double channel_window = 0.0;
    unsigned int t = windows;
    unsigned int end_window = 0U;
    const unsigned int input_end_frame = input_base_frame + input_frames;
    if (local < target_windows) {
        t = target_start_window + local;
        if (t < windows) {
            end_window = t + 1U;
            const unsigned int short_count = end_window < 30U ? end_window : 30U;
            const unsigned int short_start_window = end_window - short_count;
            const unsigned int hist_start_window = end_window >= 4U ? end_window - 4U : end_window;
            const unsigned int start_frame = short_start_window * frames_per_window;
            const unsigned int hist_start_frame = hist_start_window * frames_per_window;
            const unsigned int window_start_frame = t * frames_per_window;
            unsigned int end_frame = end_window * frames_per_window;
            if (end_frame > total_frames || end_frame < start_frame) end_frame = total_frames;

            if (end_window < 4U) {
                unsigned int seg_start = start_frame;
                unsigned int seg_end = window_start_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                for (unsigned int frame = seg_start; frame < seg_end; frame++) {
                    channel_short += source_energy[((unsigned long long)(frame - input_base_frame) * 2ULL) + c];
                }
                seg_start = window_start_frame;
                seg_end = end_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                for (unsigned int frame = seg_start; frame < seg_end; frame++) {
                    const double energy = source_energy[((unsigned long long)(frame - input_base_frame) * 2ULL) + c];
                    channel_short += energy;
                    channel_window += energy;
                }
            } else {
                unsigned int seg_start = start_frame;
                unsigned int seg_end = hist_start_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                for (unsigned int frame = seg_start; frame < seg_end; frame++) {
                    channel_short += source_energy[((unsigned long long)(frame - input_base_frame) * 2ULL) + c];
                }
                seg_start = hist_start_frame;
                seg_end = window_start_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                for (unsigned int frame = seg_start; frame < seg_end; frame++) {
                    const double energy = source_energy[((unsigned long long)(frame - input_base_frame) * 2ULL) + c];
                    channel_short += energy;
                    channel_hist4 += energy;
                }
                seg_start = window_start_frame;
                seg_end = end_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                for (unsigned int frame = seg_start; frame < seg_end; frame++) {
                    const double energy = source_energy[((unsigned long long)(frame - input_base_frame) * 2ULL) + c];
                    channel_short += energy;
                    channel_hist4 += energy;
                    channel_window += energy;
                }
            }
        }
    }
    const unsigned int shared_base = threadIdx.x * 3U;
    channel_sums[shared_base + 0U] = channel_window;
    channel_sums[shared_base + 1U] = channel_hist4;
    channel_sums[shared_base + 2U] = channel_short;
    __syncthreads();
    if ((threadIdx.x & 1U) == 0U && local < target_windows && t < windows) {
        const unsigned int shared_next = shared_base + 3U;
        const double window_total = channel_sums[shared_base + 0U] + channel_sums[shared_next + 0U];
        const double hist4_total = channel_sums[shared_base + 1U] + channel_sums[shared_next + 1U];
        const double short_total = channel_sums[shared_base + 2U] + channel_sums[shared_next + 2U];
        const unsigned long long out_base = (unsigned long long)t * 3ULL;
        source_exact_sums[out_base + 0] = window_total;
        source_exact_sums[out_base + 1] = end_window >= 4U ? hist4_total : 0.0;
        source_exact_sums[out_base + 2] = short_total;
    }
    (void)source_start_states;
    (void)b;
    (void)a;
}

extern "C" __global__ void source_stereo_exact_sums_split_unroll4_f64_kernel(
    const double *source_energy,
    double *source_exact_sums,
    const double *source_start_states,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int target_start_window,
    unsigned int target_windows,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    const double *b,
    const double *a
) {
    if (channels != 2U || !source_energy || !source_exact_sums || frames_per_window == 0U) return;
    __shared__ double channel_sums[128U * 3U];
    const unsigned int lane = blockIdx.x * blockDim.x + threadIdx.x;
    const unsigned int local = lane >> 1U;
    const unsigned int c = lane & 1U;
    double channel_short = 0.0;
    double channel_hist4 = 0.0;
    double channel_window = 0.0;
    unsigned int t = windows;
    unsigned int end_window = 0U;
    const unsigned int input_end_frame = input_base_frame + input_frames;
    if (local < target_windows) {
        t = target_start_window + local;
        if (t < windows) {
            end_window = t + 1U;
            const unsigned int short_count = end_window < 30U ? end_window : 30U;
            const unsigned int short_start_window = end_window - short_count;
            const unsigned int hist_start_window = end_window >= 4U ? end_window - 4U : end_window;
            const unsigned int start_frame = short_start_window * frames_per_window;
            const unsigned int hist_start_frame = hist_start_window * frames_per_window;
            const unsigned int window_start_frame = t * frames_per_window;
            unsigned int end_frame = end_window * frames_per_window;
            if (end_frame > total_frames || end_frame < start_frame) end_frame = total_frames;

#define SOURCE_SPLIT_ENERGY(frame_value) source_energy[((unsigned long long)((frame_value) - input_base_frame) * 2ULL) + c]
#define SOURCE_SPLIT_SHORT(frame_value) do { const double energy = SOURCE_SPLIT_ENERGY(frame_value); channel_short += energy; } while (0)
#define SOURCE_SPLIT_SHORT_WINDOW(frame_value) do { const double energy = SOURCE_SPLIT_ENERGY(frame_value); channel_short += energy; channel_window += energy; } while (0)
#define SOURCE_SPLIT_SHORT_HIST4(frame_value) do { const double energy = SOURCE_SPLIT_ENERGY(frame_value); channel_short += energy; channel_hist4 += energy; } while (0)
#define SOURCE_SPLIT_SHORT_HIST4_WINDOW(frame_value) do { const double energy = SOURCE_SPLIT_ENERGY(frame_value); channel_short += energy; channel_hist4 += energy; channel_window += energy; } while (0)

            if (end_window < 4U) {
                unsigned int seg_start = start_frame;
                unsigned int seg_end = window_start_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                unsigned int frame = seg_start;
                for (; frame + 3U < seg_end; frame += 4U) {
                    SOURCE_SPLIT_SHORT(frame);
                    SOURCE_SPLIT_SHORT(frame + 1U);
                    SOURCE_SPLIT_SHORT(frame + 2U);
                    SOURCE_SPLIT_SHORT(frame + 3U);
                }
                for (; frame < seg_end; frame++) {
                    SOURCE_SPLIT_SHORT(frame);
                }
                seg_start = window_start_frame;
                seg_end = end_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                frame = seg_start;
                for (; frame + 3U < seg_end; frame += 4U) {
                    SOURCE_SPLIT_SHORT_WINDOW(frame);
                    SOURCE_SPLIT_SHORT_WINDOW(frame + 1U);
                    SOURCE_SPLIT_SHORT_WINDOW(frame + 2U);
                    SOURCE_SPLIT_SHORT_WINDOW(frame + 3U);
                }
                for (; frame < seg_end; frame++) {
                    SOURCE_SPLIT_SHORT_WINDOW(frame);
                }
            } else {
                unsigned int seg_start = start_frame;
                unsigned int seg_end = hist_start_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                unsigned int frame = seg_start;
                for (; frame + 3U < seg_end; frame += 4U) {
                    SOURCE_SPLIT_SHORT(frame);
                    SOURCE_SPLIT_SHORT(frame + 1U);
                    SOURCE_SPLIT_SHORT(frame + 2U);
                    SOURCE_SPLIT_SHORT(frame + 3U);
                }
                for (; frame < seg_end; frame++) {
                    SOURCE_SPLIT_SHORT(frame);
                }
                seg_start = hist_start_frame;
                seg_end = window_start_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                frame = seg_start;
                for (; frame + 3U < seg_end; frame += 4U) {
                    SOURCE_SPLIT_SHORT_HIST4(frame);
                    SOURCE_SPLIT_SHORT_HIST4(frame + 1U);
                    SOURCE_SPLIT_SHORT_HIST4(frame + 2U);
                    SOURCE_SPLIT_SHORT_HIST4(frame + 3U);
                }
                for (; frame < seg_end; frame++) {
                    SOURCE_SPLIT_SHORT_HIST4(frame);
                }
                seg_start = window_start_frame;
                seg_end = end_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                frame = seg_start;
                for (; frame + 3U < seg_end; frame += 4U) {
                    SOURCE_SPLIT_SHORT_HIST4_WINDOW(frame);
                    SOURCE_SPLIT_SHORT_HIST4_WINDOW(frame + 1U);
                    SOURCE_SPLIT_SHORT_HIST4_WINDOW(frame + 2U);
                    SOURCE_SPLIT_SHORT_HIST4_WINDOW(frame + 3U);
                }
                for (; frame < seg_end; frame++) {
                    SOURCE_SPLIT_SHORT_HIST4_WINDOW(frame);
                }
            }

#undef SOURCE_SPLIT_SHORT_HIST4_WINDOW
#undef SOURCE_SPLIT_SHORT_HIST4
#undef SOURCE_SPLIT_SHORT_WINDOW
#undef SOURCE_SPLIT_SHORT
#undef SOURCE_SPLIT_ENERGY
        }
    }
    const unsigned int shared_base = threadIdx.x * 3U;
    channel_sums[shared_base + 0U] = channel_window;
    channel_sums[shared_base + 1U] = channel_hist4;
    channel_sums[shared_base + 2U] = channel_short;
    __syncthreads();
    if ((threadIdx.x & 1U) == 0U && local < target_windows && t < windows) {
        const unsigned int shared_next = shared_base + 3U;
        const double window_total = channel_sums[shared_base + 0U] + channel_sums[shared_next + 0U];
        const double hist4_total = channel_sums[shared_base + 1U] + channel_sums[shared_next + 1U];
        const double short_total = channel_sums[shared_base + 2U] + channel_sums[shared_next + 2U];
        const unsigned long long out_base = (unsigned long long)t * 3ULL;
        source_exact_sums[out_base + 0] = window_total;
        source_exact_sums[out_base + 1] = end_window >= 4U ? hist4_total : 0.0;
        source_exact_sums[out_base + 2] = short_total;
    }
    (void)source_start_states;
    (void)b;
    (void)a;
}

extern "C" __global__ void source_stereo_exact_sums_split_pointer_f64_kernel(
    const double *source_energy,
    double *source_exact_sums,
    const double *source_start_states,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int target_start_window,
    unsigned int target_windows,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    const double *b,
    const double *a
) {
    if (channels != 2U || !source_energy || !source_exact_sums || frames_per_window == 0U) return;
    __shared__ double channel_sums[128U * 3U];
    const unsigned int lane = blockIdx.x * blockDim.x + threadIdx.x;
    const unsigned int local = lane >> 1U;
    const unsigned int c = lane & 1U;
    double channel_short = 0.0;
    double channel_hist4 = 0.0;
    double channel_window = 0.0;
    unsigned int t = windows;
    unsigned int end_window = 0U;
    const unsigned int input_end_frame = input_base_frame + input_frames;
    if (local < target_windows) {
        t = target_start_window + local;
        if (t < windows) {
            end_window = t + 1U;
            const unsigned int short_count = end_window < 30U ? end_window : 30U;
            const unsigned int short_start_window = end_window - short_count;
            const unsigned int hist_start_window = end_window >= 4U ? end_window - 4U : end_window;
            const unsigned int start_frame = short_start_window * frames_per_window;
            const unsigned int hist_start_frame = hist_start_window * frames_per_window;
            const unsigned int window_start_frame = t * frames_per_window;
            unsigned int end_frame = end_window * frames_per_window;
            if (end_frame > total_frames || end_frame < start_frame) end_frame = total_frames;

            if (end_window < 4U) {
                unsigned int seg_start = start_frame;
                unsigned int seg_end = window_start_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                const double *energy_ptr = source_energy + (((unsigned long long)(seg_start - input_base_frame) * 2ULL) + c);
                for (unsigned int frame = seg_start; frame < seg_end; frame++) {
                    channel_short += *energy_ptr;
                    energy_ptr += 2U;
                }
                seg_start = window_start_frame;
                seg_end = end_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                energy_ptr = source_energy + (((unsigned long long)(seg_start - input_base_frame) * 2ULL) + c);
                for (unsigned int frame = seg_start; frame < seg_end; frame++) {
                    const double energy = *energy_ptr;
                    channel_short += energy;
                    channel_window += energy;
                    energy_ptr += 2U;
                }
            } else {
                unsigned int seg_start = start_frame;
                unsigned int seg_end = hist_start_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                const double *energy_ptr = source_energy + (((unsigned long long)(seg_start - input_base_frame) * 2ULL) + c);
                for (unsigned int frame = seg_start; frame < seg_end; frame++) {
                    channel_short += *energy_ptr;
                    energy_ptr += 2U;
                }
                seg_start = hist_start_frame;
                seg_end = window_start_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                energy_ptr = source_energy + (((unsigned long long)(seg_start - input_base_frame) * 2ULL) + c);
                for (unsigned int frame = seg_start; frame < seg_end; frame++) {
                    const double energy = *energy_ptr;
                    channel_short += energy;
                    channel_hist4 += energy;
                    energy_ptr += 2U;
                }
                seg_start = window_start_frame;
                seg_end = end_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                energy_ptr = source_energy + (((unsigned long long)(seg_start - input_base_frame) * 2ULL) + c);
                for (unsigned int frame = seg_start; frame < seg_end; frame++) {
                    const double energy = *energy_ptr;
                    channel_short += energy;
                    channel_hist4 += energy;
                    channel_window += energy;
                    energy_ptr += 2U;
                }
            }
        }
    }
    const unsigned int shared_base = threadIdx.x * 3U;
    channel_sums[shared_base + 0U] = channel_window;
    channel_sums[shared_base + 1U] = channel_hist4;
    channel_sums[shared_base + 2U] = channel_short;
    __syncthreads();
    if ((threadIdx.x & 1U) == 0U && local < target_windows && t < windows) {
        const unsigned int shared_next = shared_base + 3U;
        const double window_total = channel_sums[shared_base + 0U] + channel_sums[shared_next + 0U];
        const double hist4_total = channel_sums[shared_base + 1U] + channel_sums[shared_next + 1U];
        const double short_total = channel_sums[shared_base + 2U] + channel_sums[shared_next + 2U];
        const unsigned long long out_base = (unsigned long long)t * 3ULL;
        source_exact_sums[out_base + 0] = window_total;
        source_exact_sums[out_base + 1] = end_window >= 4U ? hist4_total : 0.0;
        source_exact_sums[out_base + 2] = short_total;
    }
    (void)source_start_states;
    (void)b;
    (void)a;
}

__device__ __forceinline__ double source_stereo_energy_readonly_load(const double *ptr) {
    return __ldg(ptr);
}

extern "C" __global__ void source_stereo_exact_sums_split_readonly_f64_kernel(
    const double *source_energy,
    double *source_exact_sums,
    const double *source_start_states,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int target_start_window,
    unsigned int target_windows,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    const double *b,
    const double *a
) {
    if (channels != 2U || !source_energy || !source_exact_sums || frames_per_window == 0U) return;
    __shared__ double channel_sums[128U * 3U];
    const unsigned int lane = blockIdx.x * blockDim.x + threadIdx.x;
    const unsigned int local = lane >> 1U;
    const unsigned int c = lane & 1U;
    double channel_short = 0.0;
    double channel_hist4 = 0.0;
    double channel_window = 0.0;
    unsigned int t = windows;
    unsigned int end_window = 0U;
    const unsigned int input_end_frame = input_base_frame + input_frames;
    if (local < target_windows) {
        t = target_start_window + local;
        if (t < windows) {
            end_window = t + 1U;
            const unsigned int short_count = end_window < 30U ? end_window : 30U;
            const unsigned int short_start_window = end_window - short_count;
            const unsigned int hist_start_window = end_window >= 4U ? end_window - 4U : end_window;
            const unsigned int start_frame = short_start_window * frames_per_window;
            const unsigned int hist_start_frame = hist_start_window * frames_per_window;
            const unsigned int window_start_frame = t * frames_per_window;
            unsigned int end_frame = end_window * frames_per_window;
            if (end_frame > total_frames || end_frame < start_frame) end_frame = total_frames;

            if (end_window < 4U) {
                unsigned int seg_start = start_frame;
                unsigned int seg_end = window_start_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                const double *energy_ptr = source_energy + (((unsigned long long)(seg_start - input_base_frame) * 2ULL) + c);
                for (unsigned int frame = seg_start; frame < seg_end; frame++) {
                    channel_short += source_stereo_energy_readonly_load(energy_ptr);
                    energy_ptr += 2U;
                }
                seg_start = window_start_frame;
                seg_end = end_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                energy_ptr = source_energy + (((unsigned long long)(seg_start - input_base_frame) * 2ULL) + c);
                for (unsigned int frame = seg_start; frame < seg_end; frame++) {
                    const double energy = source_stereo_energy_readonly_load(energy_ptr);
                    channel_short += energy;
                    channel_window += energy;
                    energy_ptr += 2U;
                }
            } else {
                unsigned int seg_start = start_frame;
                unsigned int seg_end = hist_start_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                const double *energy_ptr = source_energy + (((unsigned long long)(seg_start - input_base_frame) * 2ULL) + c);
                for (unsigned int frame = seg_start; frame < seg_end; frame++) {
                    channel_short += source_stereo_energy_readonly_load(energy_ptr);
                    energy_ptr += 2U;
                }
                seg_start = hist_start_frame;
                seg_end = window_start_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                energy_ptr = source_energy + (((unsigned long long)(seg_start - input_base_frame) * 2ULL) + c);
                for (unsigned int frame = seg_start; frame < seg_end; frame++) {
                    const double energy = source_stereo_energy_readonly_load(energy_ptr);
                    channel_short += energy;
                    channel_hist4 += energy;
                    energy_ptr += 2U;
                }
                seg_start = window_start_frame;
                seg_end = end_frame;
                if (seg_start < input_base_frame) seg_start = input_base_frame;
                if (seg_end > input_end_frame || seg_end < seg_start) seg_end = input_end_frame;
                if (seg_end > total_frames) seg_end = total_frames;
                energy_ptr = source_energy + (((unsigned long long)(seg_start - input_base_frame) * 2ULL) + c);
                for (unsigned int frame = seg_start; frame < seg_end; frame++) {
                    const double energy = source_stereo_energy_readonly_load(energy_ptr);
                    channel_short += energy;
                    channel_hist4 += energy;
                    channel_window += energy;
                    energy_ptr += 2U;
                }
            }
        }
    }
    const unsigned int shared_base = threadIdx.x * 3U;
    channel_sums[shared_base + 0U] = channel_window;
    channel_sums[shared_base + 1U] = channel_hist4;
    channel_sums[shared_base + 2U] = channel_short;
    __syncthreads();
    if ((threadIdx.x & 1U) == 0U && local < target_windows && t < windows) {
        const unsigned int shared_next = shared_base + 3U;
        const double window_total = channel_sums[shared_base + 0U] + channel_sums[shared_next + 0U];
        const double hist4_total = channel_sums[shared_base + 1U] + channel_sums[shared_next + 1U];
        const double short_total = channel_sums[shared_base + 2U] + channel_sums[shared_next + 2U];
        const unsigned long long out_base = (unsigned long long)t * 3ULL;
        source_exact_sums[out_base + 0] = window_total;
        source_exact_sums[out_base + 1] = end_window >= 4U ? hist4_total : 0.0;
        source_exact_sums[out_base + 2] = short_total;
    }
    (void)source_start_states;
    (void)b;
    (void)a;
}

extern "C" __global__ void source_stereo_exact_sums_from_channel_sums_f64_kernel(
    const double *channel_sums,
    double *source_exact_sums,
    unsigned int windows,
    unsigned int channels,
    unsigned int write_hist4,
    unsigned int write_short
) {
    if (channels != 2U || !channel_sums || !source_exact_sums) return;
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int t = blockIdx.x * blockDim.x + threadIdx.x; t < windows; t += stride) {
        const unsigned int end_window = t + 1U;
        const unsigned int short_count = end_window < 30U ? end_window : 30U;
        const unsigned int short_start_window = end_window - short_count;
        const unsigned int hist_start_window = end_window >= 4U ? end_window - 4U : end_window;
        double short_total = 0.0;
        double hist4_total = 0.0;
        double window_total = 0.0;
        for (unsigned int c = 0; c < 2U; c++) {
            double channel_short = 0.0;
            double channel_hist4 = 0.0;
            double channel_window = 0.0;
            for (unsigned int w = short_start_window; w < end_window; w++) {
                const double energy = channel_sums[((unsigned long long)w * 2ULL) + c];
                channel_short += energy;
                if (w >= hist_start_window) channel_hist4 += energy;
                if (w == t) channel_window += energy;
            }
            short_total += channel_short;
            hist4_total += channel_hist4;
            window_total += channel_window;
        }
        const unsigned long long out_base = (unsigned long long)t * 3ULL;
        source_exact_sums[out_base + 0] = window_total;
        if (write_hist4) source_exact_sums[out_base + 1] = end_window >= 4U ? hist4_total : 0.0;
        if (write_short) source_exact_sums[out_base + 2] = short_total;
    }
}

static __device__ double source_stereo_exact_short_total_f64_dev(
    const double *source_energy,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int frames_per_window,
    unsigned int window
) {
    const unsigned int end_window = window + 1U;
    const unsigned int short_count = end_window < 30U ? end_window : 30U;
    const unsigned int short_start_window = end_window - short_count;
    const unsigned int start_frame = short_start_window * frames_per_window;
    unsigned int end_frame = end_window * frames_per_window;
    if (end_frame > total_frames || end_frame < start_frame) end_frame = total_frames;
    double short_total = 0.0;
    for (unsigned int c = 0; c < 2U; c++) {
        double channel_short = 0.0;
        for (unsigned int frame = start_frame; frame < end_frame; frame++) {
            if (frame >= input_base_frame && frame < input_base_frame + input_frames) {
                channel_short += source_energy[((unsigned long long)(frame - input_base_frame) * 2ULL) + c];
            }
        }
        short_total += channel_short;
    }
    return short_total;
}

static __device__ double source_stereo_channel_short_total_f64_dev(
    const double *channel_sums,
    unsigned int windows,
    unsigned int window
) {
    if (!channel_sums || window >= windows) return 0.0;
    const unsigned int end_window = window + 1U;
    const unsigned int short_count = end_window < 30U ? end_window : 30U;
    const unsigned int short_start_window = end_window - short_count;
    double short_total = 0.0;
    for (unsigned int c = 0; c < 2U; c++) {
        for (unsigned int w = short_start_window; w < end_window; w++) {
            short_total += channel_sums[((unsigned long long)w * 2ULL) + c];
        }
    }
    return short_total;
}

static __device__ double source_stereo_channel_hist4_total_f64_dev(
    const double *channel_sums,
    unsigned int windows,
    unsigned int window
) {
    if (!channel_sums || window >= windows || window < 3U) return 0.0;
    const unsigned int hist_start_window = window - 3U;
    const unsigned int end_window = window + 1U;
    double hist4_total = 0.0;
    for (unsigned int c = 0; c < 2U; c++) {
        for (unsigned int w = hist_start_window; w < end_window; w++) {
            hist4_total += channel_sums[((unsigned long long)w * 2ULL) + c];
        }
    }
    return hist4_total;
}

extern "C" __global__ void source_stereo_exact_short_sums_f64_kernel(
    const double *source_energy,
    double *source_exact_sums,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int target_start_window,
    unsigned int target_windows,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows
) {
    if (channels != 2U || !source_energy || !source_exact_sums || frames_per_window == 0U) return;
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int local = blockIdx.x * blockDim.x + threadIdx.x; local < target_windows; local += stride) {
        const unsigned int t = target_start_window + local;
        if (t >= windows) continue;
        const double short_total = source_stereo_exact_short_total_f64_dev(source_energy, total_frames, input_base_frame, input_frames, frames_per_window, t);
        source_exact_sums[((unsigned long long)t * 3ULL) + 2ULL] = short_total;
    }
}

extern "C" __global__ void source_stereo_selective_short_sums_f64_kernel(
    const double *source_energy,
    double *source_exact_sums,
    const double *channel_sums,
    const double *hist_energies,
    const double *hist_boundaries,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int target_start_window,
    unsigned int target_windows,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    double measured_thresh,
    double margin_lu,
    unsigned int halo_windows
) {
    if (blockIdx.x != 0U || threadIdx.x != 0U) return;
    if (channels != 2U || !source_energy || !source_exact_sums || !channel_sums || !hist_energies || !hist_boundaries || frames_per_window == 0U) return;
    unsigned int target_end_window = target_start_window + target_windows;
    if (target_end_window > windows || target_end_window < target_start_window) target_end_window = windows;
    if (target_start_window >= target_end_window) return;

    for (unsigned int t = target_start_window; t < target_end_window; t++) {
        source_exact_sums[((unsigned long long)t * 3ULL) + 2ULL] = source_stereo_channel_short_total_f64_dev(channel_sums, windows, t);
    }

    unsigned int hist[1000];
    for (int i = 0; i < 1000; i++) hist[i] = 0U;
    unsigned int corrected_until = target_start_window;
    for (unsigned int t = 0; t < target_end_window; t++) {
        if (t >= 3U) {
            const double hist4_total = source_stereo_channel_hist4_total_f64_dev(channel_sums, windows, t);
            const double e = hist4_total / (double)(frames_per_window * 4U);
            if (e >= hist_boundaries[0]) hist[hist_index_from_boundaries_dev(e, hist_boundaries)]++;
        }
        if (t + halo_windows < target_start_window || t >= target_end_window) continue;
        const double approx_short = source_stereo_channel_short_total_f64_dev(channel_sums, windows, t);
        const double shortterm = energy_to_loudness_dev(approx_short / (double)(frames_per_window * 30U));
        const double relative_threshold = relative_threshold_lut_dev(hist, hist_energies);
        int near_boundary = 0;
        if (shortterm > -1.0e300) {
            if (fabs(shortterm - relative_threshold) <= margin_lu) near_boundary = 1;
            if (fabs(shortterm - measured_thresh) <= margin_lu) near_boundary = 1;
        }
        if (!near_boundary) continue;
        unsigned int start_window = t > halo_windows ? t - halo_windows : 0U;
        if (start_window < target_start_window) start_window = target_start_window;
        if (start_window < corrected_until) start_window = corrected_until;
        unsigned int end_window = t + halo_windows + 1U;
        if (end_window > target_end_window || end_window < t) end_window = target_end_window;
        for (unsigned int w = start_window; w < end_window; w++) {
            source_exact_sums[((unsigned long long)w * 3ULL) + 2ULL] = source_stereo_exact_short_total_f64_dev(source_energy, total_frames, input_base_frame, input_frames, frames_per_window, w);
        }
        corrected_until = end_window;
    }
}

extern "C" __global__ void source_stereo_exact_hist4_sums_f64_kernel(
    const double *source_energy,
    double *source_exact_sums,
    const double *channel_sums,
    const double *hist_boundaries,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int target_start_window,
    unsigned int target_windows,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    double boundary_margin_ratio,
    unsigned int selective_boundary
) {
    if (channels != 2U || !source_energy || !source_exact_sums || frames_per_window == 0U) return;
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int local = blockIdx.x * blockDim.x + threadIdx.x; local < target_windows; local += stride) {
        const unsigned int t = target_start_window + local;
        if (t >= windows) continue;
        const unsigned int end_window = t + 1U;
        const unsigned long long out_base = (unsigned long long)t * 3ULL;
        if (end_window < 4U) {
            source_exact_sums[out_base + 1] = 0.0;
            continue;
        }
        if (selective_boundary) {
            const unsigned int hist_start_window = end_window - 4U;
            double approx_hist4_total = 0.0;
            for (unsigned int c = 0; c < 2U; c++) {
                for (unsigned int w = hist_start_window; w < end_window; w++) {
                    approx_hist4_total += channel_sums[((unsigned long long)w * 2ULL) + c];
                }
            }
            source_exact_sums[out_base + 1] = approx_hist4_total;
            const double e = approx_hist4_total / (double)(frames_per_window * 4U);
            int near_boundary = 0;
            if (e >= hist_boundaries[0]) {
                const int idx = hist_index_from_boundaries_dev(e, hist_boundaries);
                if (e <= hist_boundaries[idx] * boundary_margin_ratio) near_boundary = 1;
                if (idx < 999 && e >= hist_boundaries[idx + 1] / boundary_margin_ratio) near_boundary = 1;
            } else if (e >= hist_boundaries[0] / boundary_margin_ratio) {
                near_boundary = 1;
            }
            if (!near_boundary) continue;
        }
        const unsigned int hist_start_frame = (end_window - 4U) * frames_per_window;
        unsigned int end_frame = end_window * frames_per_window;
        if (end_frame > total_frames || end_frame < hist_start_frame) end_frame = total_frames;
        double hist4_total = 0.0;
        for (unsigned int c = 0; c < 2U; c++) {
            double channel_hist4 = 0.0;
            for (unsigned int frame = hist_start_frame; frame < end_frame; frame++) {
                if (frame >= input_base_frame && frame < input_base_frame + input_frames) {
                    channel_hist4 += source_energy[((unsigned long long)(frame - input_base_frame) * 2ULL) + c];
                }
            }
            hist4_total += channel_hist4;
        }
        source_exact_sums[out_base + 1] = hist4_total;
    }
}

extern "C" __global__ void source_stereo_selective_hist4_sums_f64_kernel(
    const double *input,
    const double *source_start_states,
    double *source_exact_sums,
    const double *channel_sums,
    const double *hist_boundaries,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int target_start_window,
    unsigned int target_windows,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    const double *b,
    const double *a,
    double boundary_margin_ratio
) {
    if (channels != 2U || !input || !source_start_states || !source_exact_sums || !channel_sums || !hist_boundaries || frames_per_window == 0U) return;
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int local = blockIdx.x * blockDim.x + threadIdx.x; local < target_windows; local += stride) {
        const unsigned int t = target_start_window + local;
        if (t >= windows) continue;
        const unsigned int end_window = t + 1U;
        if (end_window < 4U) continue;
        const unsigned int hist_start_window = end_window - 4U;
        double approx_hist4_total = 0.0;
        for (unsigned int c = 0; c < 2U; c++) {
            for (unsigned int w = hist_start_window; w < end_window; w++) {
                approx_hist4_total += channel_sums[((unsigned long long)w * 2ULL) + c];
            }
        }
        const double e = approx_hist4_total / (double)(frames_per_window * 4U);
        int near_boundary = 0;
        if (e >= hist_boundaries[0]) {
            const int idx = hist_index_from_boundaries_dev(e, hist_boundaries);
            if (e <= hist_boundaries[idx] * boundary_margin_ratio) near_boundary = 1;
            if (idx < 999 && e >= hist_boundaries[idx + 1] / boundary_margin_ratio) near_boundary = 1;
        } else if (e >= hist_boundaries[0] / boundary_margin_ratio) {
            near_boundary = 1;
        }
        if (!near_boundary) continue;

        const unsigned int hist_start_frame = hist_start_window * frames_per_window;
        unsigned int end_frame = end_window * frames_per_window;
        if (end_frame > total_frames || end_frame < hist_start_frame) end_frame = total_frames;
        double hist4_total = 0.0;
        for (unsigned int c = 0; c < 2U; c++) {
            const unsigned long long state_base = ((unsigned long long)hist_start_window * 2ULL + c) * 4ULL;
            double v1 = source_start_states[state_base + 0];
            double v2 = source_start_states[state_base + 1];
            double v3 = source_start_states[state_base + 2];
            double v4 = source_start_states[state_base + 3];
            double channel_hist4 = 0.0;
            for (unsigned int frame = hist_start_frame; frame < end_frame; frame++) {
                const double x = (frame >= input_base_frame && frame < input_base_frame + input_frames) ? input[((unsigned long long)(frame - input_base_frame) * 2ULL) + c] : 0.0;
                const double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
                const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                channel_hist4 += y * y;
                v4 = v3;
                v3 = v2;
                v2 = v1;
                v1 = v0;
            }
            hist4_total += channel_hist4;
        }
        source_exact_sums[((unsigned long long)t * 3ULL) + 1ULL] = hist4_total;
    }
}

extern "C" __global__ void apply_plan_f64_io_ffmpeg_feedback_limiter_stream_kernel(
    const double *input,
    double *output,
    const double *window_sums,
    const double *source_channel_sums,
    double *source_short_ring,
    const double *hist_energies,
    const double *hist_boundaries,
    double *limiter_buf,
    double *prev_smp,
    unsigned int *state_i,
    double *state_d,
    unsigned int *hist,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int output_frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    unsigned int limiter_lookahead_frames,
    unsigned int attack_length,
    unsigned int release_length,
    const double *b,
    const double *a,
    double target_i,
    double target_lra,
    double measured_i,
    double measured_thresh,
    double offset_amp,
    double ceiling,
    unsigned int source_faithful_stereo
) {
    if (blockIdx.x != 0 || threadIdx.x != 0) return;
    const unsigned int limiter_buf_size = limiter_lookahead_frames * channels;
    const unsigned int first_frame_length = frames_per_window * 30;
    const unsigned int final_flush_frames = first_frame_length > frames_per_window ? first_frame_length - frames_per_window : 0;
    const int use_final_flush = total_frames > first_frame_length && final_flush_frames > 0 && total_frames > final_flush_frames;
    const unsigned int prefinal_frames = use_final_flush ? total_frames - final_flush_frames : total_frames;
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
    double *short_ring = state_d + FB_D_SHORT_RING;
    double *out_short_ring = state_d + FB_D_OUT_SHORT_RING;
    double *delta = state_d + FB_D_DELTA;
    double *out_states = state_d + FB_D_OUT_STATES;
    double *source_out_short_ring0 = source_faithful_stereo ? (state_d + FB_D_SOURCE_OUT_SHORT_RING0) : 0;
    double *source_out_short_ring1 = source_faithful_stereo ? (state_d + FB_D_SOURCE_OUT_SHORT_RING1) : 0;
    double *source_out_window_sum0 = source_faithful_stereo ? (state_d + FB_D_SOURCE_OUT_WINDOW_SUM0) : 0;
    double *source_out_window_sum1 = source_faithful_stereo ? (state_d + FB_D_SOURCE_OUT_WINDOW_SUM1) : 0;
    double *source_in_state0 = source_faithful_stereo ? (state_d + FB_D_SOURCE_IN_STATE0) : 0;
    double *source_in_state1 = source_faithful_stereo ? (state_d + FB_D_SOURCE_IN_STATE1) : 0;
    double *profile_counts = state_i[FB_I_PROFILE_COUNTS] ? state_d : 0;
    const int source_precomputed = source_faithful_stereo >= 2U;
    const int source_ring_active = source_faithful_stereo && !source_precomputed && channels == 2U && source_short_ring;

    if (state_i[FB_I_INITIALIZED] == 0) {
        for (int i = 0; i < 1000; i++) hist[i] = 0;
        for (int i = 0; i < 30; i++) {
            short_ring[i] = 0.0;
            out_short_ring[i] = 0.0;
            delta[i] = 1.0;
        }
        for (int i = 0; i < 20; i++) out_states[i] = 0.0;
        state_d[FB_D_SHORT_SUM] = 0.0;
        state_d[FB_D_OUT_SHORT_SUM] = 0.0;
        state_d[FB_D_OUT_WINDOW_SUM] = 0.0;
        state_d[FB_D_PREV_DELTA] = 1.0;
        state_d[FB_D_GAIN_REDUCTION0] = 1.0;
        state_d[FB_D_GAIN_REDUCTION1] = 1.0;
        if (source_faithful_stereo) {
            for (int i = 0; i < 30; i++) {
                source_out_short_ring0[i] = 0.0;
                source_out_short_ring1[i] = 0.0;
            }
            *source_out_window_sum0 = 0.0;
            *source_out_window_sum1 = 0.0;
            for (int i = 0; i < 4; i++) {
                source_in_state0[i] = 0.0;
                source_in_state1[i] = 0.0;
            }
        }
        state_i[FB_I_SHORT_INDEX] = 0;
        state_i[FB_I_OUT_SHORT_INDEX] = 0;
        state_i[FB_I_SHORT_COUNT] = 0;
        state_i[FB_I_OUT_SHORT_COUNT] = 0;
        state_i[FB_I_OUT_WINDOW_COUNT] = 0;
        state_i[FB_I_DELTA_INDEX] = 1;
        state_i[FB_I_ABOVE_THRESHOLD] = 0;
        state_i[FB_I_OUT_FRAME] = 0;
        state_i[FB_I_WRITE_FRAME] = limiter_lookahead_frames;
        state_i[FB_I_WRITE_INDEX] = 0;
        state_i[FB_I_INPUT_WINDOW] = 30;
        state_i[FB_I_FRAME_TYPE] = 0;
        state_i[FB_I_LIMITER_STATE] = 0;
        state_i[FB_I_PEAK_INDEX] = 0;
        state_i[FB_I_ENV_INDEX] = 0;
        state_i[FB_I_ENV_CNT] = 0;
        state_i[FB_I_ATTACK_STATE] = attack_length;
        state_i[FB_I_FIRST] = 1;
        state_i[FB_I_FINAL_INITIALIZED] = 0;
        state_i[FB_I_FINAL_SRC_OFFSET] = 0;
        state_i[FB_I_INPUT_MISSING] = 0;
        state_i[FB_I_LIMITER_MAYBE_ABOVE_CEILING] = 0;
        state_i[FB_I_SKIP_SAFE_FILL] = 0;
        state_i[FB_I_SKIP_SAFE_FEEDBACK] = 0;
        state_i[FB_I_FORCE_SAFE_IDLE] = 0;

        unsigned int short_count = 0;
        unsigned int short_index = 0;
        double short_sum = 0.0;
        const unsigned int first_windows = windows < 30 ? windows : 30;
        for (unsigned int t = 0; t < first_windows; t++) {
            if (source_ring_active) {
                source_input_ring_write_window_dev(input, source_short_ring, input_base_frame, input_frames, total_frames, t * frames_per_window, frames_per_window, b, a, source_in_state0, source_in_state1, state_i, profile_counts);
            }
            if (short_count == 30) {
                short_sum -= short_ring[short_index];
            } else {
                short_count++;
            }
            const double window_sum = source_precomputed ? source_precomputed_sum_dev(source_channel_sums, t, 0U, windows) : source_ring_active ? source_input_ring_sum_dev(source_short_ring, t + 1U, 1U, frames_per_window) : source_window_range_sum_dev(window_sums, source_channel_sums, t, 1U, channels, windows, source_faithful_stereo);
            short_ring[short_index] = window_sum;
            short_sum += window_sum;
            short_index++;
            if (short_index >= 30) short_index = 0;
            if (t >= 3) {
                double e = (source_precomputed ? source_precomputed_sum_dev(source_channel_sums, t, 1U, windows) : source_ring_active ? source_input_ring_sum_dev(source_short_ring, t + 1U, 4U, frames_per_window) : source_window_range_sum_dev(window_sums, source_channel_sums, t - 3U, 4U, channels, windows, source_faithful_stereo)) / (double)(frames_per_window * 4);
                if (e >= hist_boundaries[0]) hist[hist_index_from_boundaries_dev(e, hist_boundaries)]++;
            }
        }
        if (source_faithful_stereo) {
            short_sum = source_precomputed && first_windows > 0U ? source_precomputed_sum_dev(source_channel_sums, first_windows - 1U, 2U, windows) : source_ring_active ? source_input_ring_sum_dev(source_short_ring, first_windows, first_windows, frames_per_window) : source_window_range_sum_dev(window_sums, source_channel_sums, 0U, first_windows, channels, windows, source_faithful_stereo);
        }

        double shortterm = short_count > 0 ? energy_to_loudness_dev(short_sum / (double)(frames_per_window * 30)) : -1.0 / 0.0;
        double env_shortterm;
        unsigned int above_threshold;
        if (shortterm < measured_thresh) {
            above_threshold = 0;
            env_shortterm = shortterm <= -70.0 ? 0.0 : target_i - measured_i;
        } else {
            above_threshold = 1;
            env_shortterm = shortterm <= -70.0 ? 0.0 : target_i - shortterm;
        }
        double init_delta = db_to_amp_dev(env_shortterm);
        int init_maybe_above_ceiling = 0;
        for (int i = 0; i < 30; i++) delta[i] = init_delta;
        for (unsigned int c = 0; c < channels; c++) prev_smp[c] = 0.0;
        for (unsigned int n = 0; n < limiter_lookahead_frames; n++) {
            if (channels == 6U && n < total_frames && n >= input_base_frame && n < input_base_frame + input_frames) {
                const unsigned long long src_base = (unsigned long long)(n - input_base_frame) * 6ULL;
                const unsigned long long dst_base = (unsigned long long)n * 6ULL;
                const double v0 = (input[src_base + 0] * init_delta) * offset_amp;
                const double v1 = (input[src_base + 1] * init_delta) * offset_amp;
                const double v2 = (input[src_base + 2] * init_delta) * offset_amp;
                const double v3 = (input[src_base + 3] * init_delta) * offset_amp;
                const double v4 = (input[src_base + 4] * init_delta) * offset_amp;
                const double v5 = (input[src_base + 5] * init_delta) * offset_amp;
                if (v0 > ceiling || v0 < -ceiling || v1 > ceiling || v1 < -ceiling || v2 > ceiling || v2 < -ceiling || v3 > ceiling || v3 < -ceiling || v4 > ceiling || v4 < -ceiling || v5 > ceiling || v5 < -ceiling) init_maybe_above_ceiling = 1;
                limiter_buf[dst_base + 0] = v0;
                limiter_buf[dst_base + 1] = v1;
                limiter_buf[dst_base + 2] = v2;
                limiter_buf[dst_base + 3] = v3;
                limiter_buf[dst_base + 4] = v4;
                limiter_buf[dst_base + 5] = v5;
                if (profile_counts) {
                    profile_counts[FB_D_COUNT_INPUT_READS] += 6.0;
                    profile_counts[FB_D_COUNT_LIMITER_WRITES] += 6.0;
                }
            } else {
                for (unsigned int c = 0; c < channels; c++) {
                    double v = (feedback_input_sample_dev(input, input_base_frame, input_frames, total_frames, n, c, channels, state_i, profile_counts) * init_delta) * offset_amp;
                    if (v > ceiling || v < -ceiling) init_maybe_above_ceiling = 1;
                    limiter_buf[((unsigned long long)n * channels) + c] = v;
                    if (profile_counts) profile_counts[FB_D_COUNT_LIMITER_WRITES] += 1.0;
                }
            }
        }
        state_d[FB_D_SHORT_SUM] = short_sum;
        state_d[FB_D_PREV_DELTA] = delta[1];
        state_i[FB_I_SHORT_INDEX] = short_index;
        state_i[FB_I_SHORT_COUNT] = short_count;
        state_i[FB_I_ABOVE_THRESHOLD] = above_threshold;
        state_i[FB_I_LIMITER_MAYBE_ABOVE_CEILING] = (unsigned int)init_maybe_above_ceiling;
        state_i[FB_I_INITIALIZED] = 1;
    }

    unsigned int short_index = state_i[FB_I_SHORT_INDEX];
    int out_short_index = (int)state_i[FB_I_OUT_SHORT_INDEX];
    unsigned int short_count = state_i[FB_I_SHORT_COUNT];
    int out_short_count = (int)state_i[FB_I_OUT_SHORT_COUNT];
    unsigned int out_window_count = state_i[FB_I_OUT_WINDOW_COUNT];
    int index = (int)state_i[FB_I_DELTA_INDEX];
    int above_threshold = (int)state_i[FB_I_ABOVE_THRESHOLD];
    unsigned int out_frame = state_i[FB_I_OUT_FRAME];
    unsigned int write_frame = state_i[FB_I_WRITE_FRAME];
    unsigned int write_index = state_i[FB_I_WRITE_INDEX];
    unsigned int input_window = state_i[FB_I_INPUT_WINDOW];
    int frame_type = (int)state_i[FB_I_FRAME_TYPE];
    int limiter_state = (int)state_i[FB_I_LIMITER_STATE];
    int peak_index = (int)state_i[FB_I_PEAK_INDEX];
    int env_index = (int)state_i[FB_I_ENV_INDEX];
    int env_cnt = (int)state_i[FB_I_ENV_CNT];
    int attack_state = (int)state_i[FB_I_ATTACK_STATE];
    int first = (int)state_i[FB_I_FIRST];
    int final_initialized = (int)state_i[FB_I_FINAL_INITIALIZED];
    unsigned int final_src_offset = state_i[FB_I_FINAL_SRC_OFFSET];
    int limiter_maybe_above_ceiling = (int)state_i[FB_I_LIMITER_MAYBE_ABOVE_CEILING];
    const int skip_safe_fill = (int)state_i[FB_I_SKIP_SAFE_FILL];
    const int skip_safe_feedback = (int)state_i[FB_I_SKIP_SAFE_FEEDBACK];
    const int force_safe_idle = (int)state_i[FB_I_FORCE_SAFE_IDLE];
    double short_sum = state_d[FB_D_SHORT_SUM];
    double out_short_sum = state_d[FB_D_OUT_SHORT_SUM];
    double out_window_sum = state_d[FB_D_OUT_WINDOW_SUM];
    double prev_delta = state_d[FB_D_PREV_DELTA];
    double gain_reduction0 = state_d[FB_D_GAIN_REDUCTION0];
    double gain_reduction1 = state_d[FB_D_GAIN_REDUCTION1];
    unsigned int produced = 0;

    while (produced < output_frames && out_frame < total_frames) {
        if (use_final_flush && out_frame >= prefinal_frames) {
            if (!final_initialized) {
                const double final_gain = gaussian_filter_dev(delta, weights, (index + 10) < 30 ? (index + 10) : (index + 10 - 30));
                write_index = 0;
                for (unsigned int n = 0; n < limiter_lookahead_frames; n++) {
                    const unsigned int src_frame = prefinal_frames + n;
                    if (channels == 6U && src_frame < total_frames && src_frame >= input_base_frame && src_frame < input_base_frame + input_frames) {
                        const unsigned long long src_base = (unsigned long long)(src_frame - input_base_frame) * 6ULL;
                        const unsigned long long dst_base = (unsigned long long)n * 6ULL;
                        const double v0 = (input[src_base + 0] * final_gain) * offset_amp;
                        const double v1 = (input[src_base + 1] * final_gain) * offset_amp;
                        const double v2 = (input[src_base + 2] * final_gain) * offset_amp;
                        const double v3 = (input[src_base + 3] * final_gain) * offset_amp;
                        const double v4 = (input[src_base + 4] * final_gain) * offset_amp;
                        const double v5 = (input[src_base + 5] * final_gain) * offset_amp;
                        if (v0 > ceiling || v0 < -ceiling || v1 > ceiling || v1 < -ceiling || v2 > ceiling || v2 < -ceiling || v3 > ceiling || v3 < -ceiling || v4 > ceiling || v4 < -ceiling || v5 > ceiling || v5 < -ceiling) limiter_maybe_above_ceiling = 1;
                        limiter_buf[dst_base + 0] = v0;
                        limiter_buf[dst_base + 1] = v1;
                        limiter_buf[dst_base + 2] = v2;
                        limiter_buf[dst_base + 3] = v3;
                        limiter_buf[dst_base + 4] = v4;
                        limiter_buf[dst_base + 5] = v5;
                        if (profile_counts) {
                            profile_counts[FB_D_COUNT_INPUT_READS] += 6.0;
                            profile_counts[FB_D_COUNT_LIMITER_WRITES] += 6.0;
                        }
                    } else {
                        for (unsigned int c = 0; c < channels; c++) {
                            double v = (feedback_input_sample_dev(input, input_base_frame, input_frames, total_frames, src_frame, c, channels, state_i, profile_counts) * final_gain) * offset_amp;
                            if (v > ceiling || v < -ceiling) limiter_maybe_above_ceiling = 1;
                            limiter_buf[((unsigned long long)n * channels) + c] = v;
                            if (profile_counts) profile_counts[FB_D_COUNT_LIMITER_WRITES] += 1.0;
                        }
                    }
                }
                final_src_offset = limiter_lookahead_frames;
                frame_type = 2;
                final_initialized = 1;
            }
            unsigned int nb = frames_per_window;
            if (nb > total_frames - out_frame) nb = total_frames - out_frame;
            if (nb > output_frames - produced) nb = output_frames - produced;
            int final_limiter_flag = (state_i[FB_I_PREFILLED_OUTPUT] && state_i[FB_I_PREFILL_CHUNK_SAFE]) ? -1 : limiter_maybe_above_ceiling;
            true_peak_limiter_dev(limiter_buf, output, produced, nb, channels, limiter_buf_size, write_index * channels, attack_length, release_length, ceiling, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, profile_counts, final_limiter_flag, 1, 0, 0, 0, 0, 0);
            out_frame += nb;
            produced += nb;

            const double final_gain = gaussian_filter_dev(delta, weights, (index + 10) < 30 ? (index + 10) : (index + 10 - 30));
            for (unsigned int n = 0; n < frames_per_window; n++) {
                const unsigned int src_frame = prefinal_frames + final_src_offset;
                const int have_src = final_src_offset < final_flush_frames && src_frame < total_frames;
                if (channels == 6U && have_src && src_frame >= input_base_frame && src_frame < input_base_frame + input_frames) {
                    const unsigned long long src_base = (unsigned long long)(src_frame - input_base_frame) * 6ULL;
                    const unsigned long long dst_base = (unsigned long long)write_index * 6ULL;
                    const double v0 = (input[src_base + 0] * final_gain) * offset_amp;
                    const double v1 = (input[src_base + 1] * final_gain) * offset_amp;
                    const double v2 = (input[src_base + 2] * final_gain) * offset_amp;
                    const double v3 = (input[src_base + 3] * final_gain) * offset_amp;
                    const double v4 = (input[src_base + 4] * final_gain) * offset_amp;
                    const double v5 = (input[src_base + 5] * final_gain) * offset_amp;
                    if (v0 > ceiling || v0 < -ceiling || v1 > ceiling || v1 < -ceiling || v2 > ceiling || v2 < -ceiling || v3 > ceiling || v3 < -ceiling || v4 > ceiling || v4 < -ceiling || v5 > ceiling || v5 < -ceiling) limiter_maybe_above_ceiling = 1;
                    limiter_buf[dst_base + 0] = v0;
                    limiter_buf[dst_base + 1] = v1;
                    limiter_buf[dst_base + 2] = v2;
                    limiter_buf[dst_base + 3] = v3;
                    limiter_buf[dst_base + 4] = v4;
                    limiter_buf[dst_base + 5] = v5;
                    if (profile_counts) {
                        profile_counts[FB_D_COUNT_INPUT_READS] += 6.0;
                        profile_counts[FB_D_COUNT_LIMITER_WRITES] += 6.0;
                    }
                } else if (channels == 6U && !have_src) {
                    const unsigned long long dst_base = (unsigned long long)write_index * 6ULL;
                    limiter_buf[dst_base + 0] = 0.0;
                    limiter_buf[dst_base + 1] = 0.0;
                    limiter_buf[dst_base + 2] = 0.0;
                    limiter_buf[dst_base + 3] = 0.0;
                    limiter_buf[dst_base + 4] = 0.0;
                    limiter_buf[dst_base + 5] = 0.0;
                    if (profile_counts) profile_counts[FB_D_COUNT_LIMITER_WRITES] += 6.0;
                } else {
                    for (unsigned int c = 0; c < channels; c++) {
                        double v = have_src ? (feedback_input_sample_dev(input, input_base_frame, input_frames, total_frames, src_frame, c, channels, state_i, profile_counts) * final_gain) * offset_amp : 0.0;
                        if (v > ceiling || v < -ceiling) limiter_maybe_above_ceiling = 1;
                        limiter_buf[((unsigned long long)write_index * channels) + c] = v;
                        if (profile_counts) profile_counts[FB_D_COUNT_LIMITER_WRITES] += 1.0;
                    }
                }
                if (have_src) final_src_offset++;
                write_index++;
                if (write_index >= limiter_lookahead_frames) write_index = 0;
            }
            continue;
        }

        unsigned int nb = frames_per_window;
        if (nb > prefinal_frames - out_frame) nb = prefinal_frames - out_frame;
        if (nb > output_frames - produced) nb = output_frames - produced;
        if (force_safe_idle && state_i[FB_I_PREFILLED_OUTPUT] && state_i[FB_I_PREFILL_CHUNK_SAFE] && above_threshold != 0 && channels == 6U) {
            limiter_state = 0;
            peak_index = 0;
            env_index = 0;
            env_cnt = 0;
            attack_state = (int)attack_length;
            gain_reduction0 = 1.0;
            gain_reduction1 = 1.0;
        }
        if (!first) {
            double gain = gaussian_filter_dev(delta, weights, (index + 10) < 30 ? (index + 10) : (index + 10 - 30));
            double gain_next = gaussian_filter_dev(delta, weights, (index + 11) < 30 ? (index + 11) : (index + 11 - 30));
            const double gain_diff = gain_next - gain;
            if (skip_safe_fill && state_i[FB_I_PREFILLED_OUTPUT] && state_i[FB_I_PREFILL_CHUNK_SAFE] && above_threshold != 0 && limiter_state == 0 && channels == 6U) {
                write_index += nb;
                while (write_index >= limiter_lookahead_frames) write_index -= limiter_lookahead_frames;
                write_frame += nb;
                } else for (unsigned int n = 0; n < nb; n++) {
                double timed_gain = gain + (((double)n / (double)nb) * gain_diff);
                if (channels == 6U && write_frame < total_frames && write_frame >= input_base_frame && write_frame < input_base_frame + input_frames) {
                    const unsigned long long src_base = (unsigned long long)(write_frame - input_base_frame) * 6ULL;
                    const unsigned long long dst_base = (unsigned long long)write_index * 6ULL;
                    const double v0 = (input[src_base + 0] * timed_gain) * offset_amp;
                    const double v1 = (input[src_base + 1] * timed_gain) * offset_amp;
                    const double v2 = (input[src_base + 2] * timed_gain) * offset_amp;
                    const double v3 = (input[src_base + 3] * timed_gain) * offset_amp;
                    const double v4 = (input[src_base + 4] * timed_gain) * offset_amp;
                    const double v5 = (input[src_base + 5] * timed_gain) * offset_amp;
                    if (v0 > ceiling || v0 < -ceiling || v1 > ceiling || v1 < -ceiling || v2 > ceiling || v2 < -ceiling || v3 > ceiling || v3 < -ceiling || v4 > ceiling || v4 < -ceiling || v5 > ceiling || v5 < -ceiling) limiter_maybe_above_ceiling = 1;
                    limiter_buf[dst_base + 0] = v0;
                    limiter_buf[dst_base + 1] = v1;
                    limiter_buf[dst_base + 2] = v2;
                    limiter_buf[dst_base + 3] = v3;
                    limiter_buf[dst_base + 4] = v4;
                    limiter_buf[dst_base + 5] = v5;
                    if (profile_counts) {
                        profile_counts[FB_D_COUNT_INPUT_READS] += 6.0;
                        profile_counts[FB_D_COUNT_LIMITER_WRITES] += 6.0;
                    }
                } else {
                    for (unsigned int c = 0; c < channels; c++) {
                        double v = (feedback_input_sample_dev(input, input_base_frame, input_frames, total_frames, write_frame, c, channels, state_i, profile_counts) * timed_gain) * offset_amp;
                        if (v > ceiling || v < -ceiling) limiter_maybe_above_ceiling = 1;
                        limiter_buf[((unsigned long long)write_index * channels) + c] = v;
                        if (profile_counts) profile_counts[FB_D_COUNT_LIMITER_WRITES] += 1.0;
                    }
                }
                write_index++;
                if (write_index >= limiter_lookahead_frames) write_index = 0;
                write_frame++;
            }
            if (nb < frames_per_window) {
                write_index += frames_per_window - nb;
                while (write_index >= limiter_lookahead_frames) write_index -= limiter_lookahead_frames;
            }
        }
        int normal_limiter_flag = (skip_safe_fill && state_i[FB_I_PREFILLED_OUTPUT] && state_i[FB_I_PREFILL_CHUNK_SAFE] && above_threshold != 0 && limiter_state == 0 && channels == 6U) ? -2 : ((state_i[FB_I_PREFILLED_OUTPUT] && state_i[FB_I_PREFILL_CHUNK_SAFE] && above_threshold != 0) ? -1 : limiter_maybe_above_ceiling);
        int feedback_short_count_arg = skip_safe_feedback && normal_limiter_flag < -1 ? -1 : out_short_count;
        true_peak_limiter_dev(limiter_buf, output, produced, nb, channels, limiter_buf_size, write_index * channels, attack_length, release_length, ceiling, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1, 1, frames_per_window, b, a, out_states, out_short_ring, &out_short_sum, &out_short_index, &feedback_short_count_arg, &out_window_sum, &out_window_count, profile_counts, normal_limiter_flag, 1, source_faithful_stereo, source_out_short_ring0, source_out_short_ring1, source_out_window_sum0, source_out_window_sum1);
        if (feedback_short_count_arg >= 0) out_short_count = feedback_short_count_arg;
        out_frame += nb;
        produced += nb;
        frame_type = 1;
        if (first) {
            first = 0;
            continue;
        }

        if (input_window < windows) {
            if (source_ring_active) {
                source_input_ring_write_window_dev(input, source_short_ring, input_base_frame, input_frames, total_frames, input_window * frames_per_window, frames_per_window, b, a, source_in_state0, source_in_state1, state_i, profile_counts);
            }
            if (short_count == 30) {
                short_sum -= short_ring[short_index];
            } else {
                short_count++;
            }
            const double window_sum = source_precomputed ? source_precomputed_sum_dev(source_channel_sums, input_window, 0U, windows) : source_ring_active ? source_input_ring_sum_dev(source_short_ring, input_window + 1U, 1U, frames_per_window) : source_window_range_sum_dev(window_sums, source_channel_sums, input_window, 1U, channels, windows, source_faithful_stereo);
            short_ring[short_index] = window_sum;
            short_sum += window_sum;
            short_index++;
            if (short_index >= 30) short_index = 0;
            if (source_faithful_stereo) {
                const unsigned int short_start = (input_window + 1U) > short_count ? (input_window + 1U - short_count) : 0U;
                short_sum = source_precomputed ? source_precomputed_sum_dev(source_channel_sums, input_window, 2U, windows) : source_ring_active ? source_input_ring_sum_dev(source_short_ring, input_window + 1U, short_count, frames_per_window) : source_window_range_sum_dev(window_sums, source_channel_sums, short_start, short_count, channels, windows, source_faithful_stereo);
            }
            if (input_window >= 3) {
                double e = (source_precomputed ? source_precomputed_sum_dev(source_channel_sums, input_window, 1U, windows) : source_ring_active ? source_input_ring_sum_dev(source_short_ring, input_window + 1U, 4U, frames_per_window) : source_window_range_sum_dev(window_sums, source_channel_sums, input_window - 3U, 4U, channels, windows, source_faithful_stereo)) / (double)(frames_per_window * 4);
                if (e >= hist_boundaries[0]) hist[hist_index_from_boundaries_dev(e, hist_boundaries)]++;
            }
        }

        const double global = gated_loudness_lut_boundaries_dev(hist, hist_energies, hist_boundaries);
        const double short_energy = short_sum / (double)(frames_per_window * 30);
        const double shortterm = energy_to_loudness_dev(short_energy);
        const double relative_threshold = relative_threshold_lut_dev(hist, hist_energies);
        if (above_threshold == 0) {
            double shortterm_out = energy_to_loudness_dev(out_short_sum / (double)(frames_per_window * 30));
            if (shortterm > measured_thresh) prev_delta *= 1.0058;
            if (shortterm_out >= target_i) above_threshold = 1;
        }
        if (shortterm < relative_threshold || shortterm <= -70.0 || above_threshold == 0) {
            delta[index] = prev_delta;
        } else {
            double diff = isfinite(global) ? (shortterm - global) : 0.0;
            double limit = target_lra / 2.0;
            double env_global = fabs(diff) < limit ? diff : (diff < 0.0 ? -limit : limit);
            double env_shortterm = target_i - shortterm;
            delta[index] = db_to_amp_dev(env_global + env_shortterm);
        }
        prev_delta = delta[index];
        index++;
        if (index >= 30) index = 0;
        input_window++;
    }

    state_i[FB_I_SHORT_INDEX] = short_index;
    state_i[FB_I_OUT_SHORT_INDEX] = (unsigned int)out_short_index;
    state_i[FB_I_SHORT_COUNT] = short_count;
    state_i[FB_I_OUT_SHORT_COUNT] = (unsigned int)out_short_count;
    state_i[FB_I_OUT_WINDOW_COUNT] = out_window_count;
    state_i[FB_I_DELTA_INDEX] = (unsigned int)index;
    state_i[FB_I_ABOVE_THRESHOLD] = (unsigned int)above_threshold;
    state_i[FB_I_OUT_FRAME] = out_frame;
    state_i[FB_I_WRITE_FRAME] = write_frame;
    state_i[FB_I_WRITE_INDEX] = write_index;
    state_i[FB_I_INPUT_WINDOW] = input_window;
    state_i[FB_I_FRAME_TYPE] = (unsigned int)frame_type;
    state_i[FB_I_LIMITER_STATE] = (unsigned int)limiter_state;
    state_i[FB_I_PEAK_INDEX] = (unsigned int)peak_index;
    state_i[FB_I_ENV_INDEX] = (unsigned int)env_index;
    state_i[FB_I_ENV_CNT] = (unsigned int)env_cnt;
    state_i[FB_I_ATTACK_STATE] = (unsigned int)attack_state;
    state_i[FB_I_FIRST] = (unsigned int)first;
    state_i[FB_I_FINAL_INITIALIZED] = (unsigned int)final_initialized;
    state_i[FB_I_FINAL_SRC_OFFSET] = final_src_offset;
    state_i[FB_I_LIMITER_MAYBE_ABOVE_CEILING] = (unsigned int)limiter_maybe_above_ceiling;
    state_i[FB_I_SKIP_SAFE_FILL] = 0;
    state_i[FB_I_SKIP_SAFE_FEEDBACK] = 0;
    state_i[FB_I_FORCE_SAFE_IDLE] = 0;
    state_d[FB_D_SHORT_SUM] = short_sum;
    state_d[FB_D_OUT_SHORT_SUM] = out_short_sum;
    state_d[FB_D_OUT_WINDOW_SUM] = out_window_sum;
    state_d[FB_D_PREV_DELTA] = prev_delta;
    state_d[FB_D_GAIN_REDUCTION0] = gain_reduction0;
    state_d[FB_D_GAIN_REDUCTION1] = gain_reduction1;
}

extern "C" __global__ void apply_plan_f64_io_ffmpeg_feedback_limiter_kernel(
    const double *input,
    double *output,
    const double *window_sums,
    const double *hist_energies,
    const double *hist_boundaries,
    double *limiter_buf,
    double *prev_smp,
    unsigned int samples,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    unsigned int limiter_lookahead_frames,
    unsigned int attack_length,
    unsigned int release_length,
    const double *b,
    const double *a,
    double target_i,
    double target_lra,
    double measured_i,
    double measured_thresh,
    double offset_amp,
    double ceiling
) {
    if (blockIdx.x != 0 || threadIdx.x != 0) return;
    const unsigned int total_frames = samples / channels;
    const unsigned int limiter_buf_size = limiter_lookahead_frames * channels;
    const unsigned int first_frame_length = frames_per_window * 30;
    const unsigned int final_flush_frames = first_frame_length > frames_per_window ? first_frame_length - frames_per_window : 0;
    const int use_final_flush = total_frames > first_frame_length && final_flush_frames > 0 && total_frames > final_flush_frames;
    const unsigned int prefinal_frames = use_final_flush ? total_frames - final_flush_frames : total_frames;
    unsigned int hist[1000];
    for (int i = 0; i < 1000; i++) hist[i] = 0;
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
    double out_states[20];
    for (int i = 0; i < 30; i++) {
        short_ring[i] = 0.0;
        out_short_ring[i] = 0.0;
        delta[i] = 1.0;
    }
    for (int i = 0; i < 20; i++) out_states[i] = 0.0;
    double short_sum = 0.0;
    double out_short_sum = 0.0;
    double out_window_sum = 0.0;
    unsigned int out_window_count = 0;
    int short_index = 0;
    int out_short_index = 0;
    int short_count = 0;
    int out_short_count = 0;
    int index = 1;
    int above_threshold = 0;
    double prev_delta = 1.0;

    const unsigned int first_windows = windows < 30 ? windows : 30;
    for (unsigned int t = 0; t < first_windows; t++) {
        if (short_count == 30) {
            short_sum -= short_ring[short_index];
        } else {
            short_count++;
        }
        short_ring[short_index] = window_sums[t];
        short_sum += window_sums[t];
        short_index++;
        if (short_index >= 30) short_index = 0;
        if (t >= 3) {
            double e = (window_sums[t] + window_sums[t - 1] + window_sums[t - 2] + window_sums[t - 3]) / (double)(frames_per_window * 4);
            if (e >= hist_boundaries[0]) hist[hist_index_from_boundaries_dev(e, hist_boundaries)]++;
        }
    }

    double shortterm = short_count > 0 ? energy_to_loudness_dev(short_sum / (double)(frames_per_window * 30)) : -1.0 / 0.0;
    double env_shortterm;
    if (shortterm < measured_thresh) {
        above_threshold = 0;
        env_shortterm = shortterm <= -70.0 ? 0.0 : target_i - measured_i;
    } else {
        above_threshold = 1;
        env_shortterm = shortterm <= -70.0 ? 0.0 : target_i - shortterm;
    }
    double init_gain = db_to_amp_dev(env_shortterm) * offset_amp;
    for (int i = 0; i < 30; i++) delta[i] = db_to_amp_dev(env_shortterm);
    prev_delta = delta[index];

    for (unsigned int c = 0; c < channels; c++) prev_smp[c] = 0.0;
    for (unsigned int n = 0; n < limiter_lookahead_frames; n++) {
        for (unsigned int c = 0; c < channels; c++) {
            double v = n < total_frames ? input[((unsigned long long)n * channels) + c] * init_gain : 0.0;
            limiter_buf[((unsigned long long)n * channels) + c] = v;
        }
    }

    unsigned int out_frame = 0;
    unsigned int write_frame = limiter_lookahead_frames;
    unsigned int write_index = 0;
    unsigned int limiter_buf_index = 0;
    unsigned int input_window = 30;
    int frame_type = 0;
    int limiter_state = 0;
    int peak_index = 0;
    int env_index = 0;
    int env_cnt = 0;
    int attack_state = (int)attack_length;
    double gain_reduction0 = 1.0;
    double gain_reduction1 = 1.0;
    int first = 1;

    while (out_frame < prefinal_frames) {
        unsigned int nb = frames_per_window;
        if (nb > prefinal_frames - out_frame) nb = prefinal_frames - out_frame;
        if (!first) {
            double gain = gaussian_filter_dev(delta, weights, (index + 10) < 30 ? (index + 10) : (index + 10 - 30));
            double gain_next = gaussian_filter_dev(delta, weights, (index + 11) < 30 ? (index + 11) : (index + 11 - 30));
            for (unsigned int n = 0; n < nb; n++) {
                double interp = nb > 0 ? (double)n / (double)nb : 0.0;
                double timed_gain = (gain + interp * (gain_next - gain)) * offset_amp;
                for (unsigned int c = 0; c < channels; c++) {
                    double v = write_frame < total_frames ? input[((unsigned long long)write_frame * channels) + c] * timed_gain : 0.0;
                    limiter_buf[((unsigned long long)write_index * channels) + c] = v;
                }
                write_index++;
                if (write_index >= limiter_lookahead_frames) write_index = 0;
                write_frame++;
            }
            if (nb < frames_per_window) {
                write_index += frames_per_window - nb;
                while (write_index >= limiter_lookahead_frames) write_index -= limiter_lookahead_frames;
            }
            limiter_buf_index = write_index * channels;
        }
        true_peak_limiter_dev(limiter_buf, output, out_frame, nb, channels, limiter_buf_size, limiter_buf_index, attack_length, release_length, ceiling, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0);
        add_feedback_output_dev(output, out_frame, nb, channels, frames_per_window, b, a, out_states, out_short_ring, &out_short_sum, &out_short_index, &out_short_count, &out_window_sum, &out_window_count);
        out_frame += nb;
        frame_type = 1;
        if (first) {
            first = 0;
            continue;
        }

        if (input_window < windows) {
            if (short_count == 30) {
                short_sum -= short_ring[short_index];
            } else {
                short_count++;
            }
            short_ring[short_index] = window_sums[input_window];
            short_sum += window_sums[input_window];
            short_index++;
            if (short_index >= 30) short_index = 0;
            if (input_window >= 3) {
                double e = (window_sums[input_window] + window_sums[input_window - 1] + window_sums[input_window - 2] + window_sums[input_window - 3]) / (double)(frames_per_window * 4);
                if (e >= hist_boundaries[0]) hist[hist_index_from_boundaries_dev(e, hist_boundaries)]++;
            }
        }

        const double global = gated_loudness_lut_boundaries_dev(hist, hist_energies, hist_boundaries);
        shortterm = energy_to_loudness_dev(short_sum / (double)(frames_per_window * 30));
        const double relative_threshold = relative_threshold_lut_dev(hist, hist_energies);
        if (above_threshold == 0) {
            double shortterm_out = energy_to_loudness_dev(out_short_sum / (double)(frames_per_window * 30));
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
            delta[index] = db_to_amp_dev(env_global + env_shortterm);
        }
        prev_delta = delta[index];
        index++;
        if (index >= 30) index = 0;
        input_window++;
    }

    if (use_final_flush && out_frame < total_frames) {
        const double final_gain = gaussian_filter_dev(delta, weights, (index + 10) < 30 ? (index + 10) : (index + 10 - 30)) * offset_amp;
        limiter_buf_index = 0;
        write_index = 0;
        for (unsigned int n = 0; n < limiter_lookahead_frames; n++) {
            const unsigned int src_frame = prefinal_frames + n;
            for (unsigned int c = 0; c < channels; c++) {
                double v = src_frame < total_frames ? input[((unsigned long long)src_frame * channels) + c] * final_gain : 0.0;
                limiter_buf[((unsigned long long)n * channels) + c] = v;
            }
        }

        unsigned int final_src_offset = limiter_lookahead_frames;
        frame_type = 2;
        while (out_frame < total_frames) {
            unsigned int nb = frames_per_window;
            if (nb > total_frames - out_frame) nb = total_frames - out_frame;
            true_peak_limiter_dev(limiter_buf, output, out_frame, nb, channels, limiter_buf_size, limiter_buf_index, attack_length, release_length, ceiling, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0);
            out_frame += nb;

            for (unsigned int n = 0; n < frames_per_window; n++) {
                const unsigned int src_frame = prefinal_frames + final_src_offset;
                const int have_src = final_src_offset < final_flush_frames && src_frame < total_frames;
                for (unsigned int c = 0; c < channels; c++) {
                    double v = have_src ? input[((unsigned long long)src_frame * channels) + c] * final_gain : 0.0;
                    limiter_buf[((unsigned long long)write_index * channels) + c] = v;
                }
                if (have_src) final_src_offset++;
                write_index++;
                if (write_index >= limiter_lookahead_frames) write_index = 0;
            }
            limiter_buf_index = write_index * channels;
        }
    }
}

extern "C" __global__ void apply_plan_f64_io_ffmpeg_limiter_kernel(
    const double *input,
    double *output,
    const float *gains,
    const float *gains_next,
    double *limiter_buf,
    double *prev_smp,
    unsigned int samples,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    unsigned int limiter_lookahead_frames,
    unsigned int gain_timing_offset_frames,
    unsigned int attack_length,
    unsigned int release_length,
    double ceiling
) {
    if (blockIdx.x != 0 || threadIdx.x != 0) return;
    const unsigned int total_frames = samples / channels;
    const unsigned int limiter_buf_size = limiter_lookahead_frames * channels;
    const double limit = ceiling;
    const unsigned int first_frame_length = frames_per_window * 30;
    const unsigned int final_flush_frames = first_frame_length > frames_per_window ? first_frame_length - frames_per_window : 0;
    const int use_final_flush = total_frames > first_frame_length && final_flush_frames > 0 && total_frames > final_flush_frames;
    const unsigned int prefinal_frames = use_final_flush ? total_frames - final_flush_frames : total_frames;
    for (unsigned int c = 0; c < channels; c++) prev_smp[c] = 0.0;

    for (unsigned int n = 0; n < limiter_lookahead_frames; n++) {
        double gain = ffmpeg_timed_gain_dev(gains, gains_next, n, frames_per_window, windows, limiter_lookahead_frames, gain_timing_offset_frames);
        for (unsigned int c = 0; c < channels; c++) {
            double v = n < total_frames ? input[((unsigned long long)n * channels) + c] * gain : 0.0;
            limiter_buf[((unsigned long long)n * channels) + c] = v;
        }
    }

    unsigned int out_frame = 0;
    unsigned int write_frame = limiter_lookahead_frames;
    unsigned int write_index = 0;
    unsigned int limiter_buf_index = 0;
    int frame_type = 0;
    int limiter_state = 0;
    int peak_index = 0;
    int env_index = 0;
    int env_cnt = 0;
    int attack_state = (int)attack_length;
    double gain_reduction0 = 1.0;
    double gain_reduction1 = 1.0;
    int first = 1;

    while (out_frame < prefinal_frames) {
        unsigned int nb = frames_per_window;
        if (nb > prefinal_frames - out_frame) nb = prefinal_frames - out_frame;
        if (!first) {
            for (unsigned int n = 0; n < nb; n++) {
                double gain = ffmpeg_timed_gain_dev(gains, gains_next, write_frame, frames_per_window, windows, limiter_lookahead_frames, gain_timing_offset_frames);
                for (unsigned int c = 0; c < channels; c++) {
                    double v = write_frame < total_frames ? input[((unsigned long long)write_frame * channels) + c] * gain : 0.0;
                    limiter_buf[((unsigned long long)write_index * channels) + c] = v;
                }
                write_index++;
                if (write_index >= limiter_lookahead_frames) write_index = 0;
                write_frame++;
            }
            if (nb < frames_per_window) {
                write_index += frames_per_window - nb;
                while (write_index >= limiter_lookahead_frames) write_index -= limiter_lookahead_frames;
            }
            limiter_buf_index = write_index * channels;
        }
        true_peak_limiter_dev(limiter_buf, output, out_frame, nb, channels, limiter_buf_size, limiter_buf_index, attack_length, release_length, limit, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0);
        out_frame += nb;
        frame_type = 1;
        first = 0;
    }

    if (use_final_flush && out_frame < total_frames) {
        unsigned int final_gain_index = (prefinal_frames / frames_per_window) + 1;
        if (final_gain_index >= windows) final_gain_index = windows - 1;
        const double final_gain = (double)gains[final_gain_index];

        limiter_buf_index = 0;
        write_index = 0;
        for (unsigned int n = 0; n < limiter_lookahead_frames; n++) {
            const unsigned int src_frame = prefinal_frames + n;
            for (unsigned int c = 0; c < channels; c++) {
                double v = src_frame < total_frames ? input[((unsigned long long)src_frame * channels) + c] * final_gain : 0.0;
                limiter_buf[((unsigned long long)n * channels) + c] = v;
            }
        }

        unsigned int final_src_offset = limiter_lookahead_frames;
        frame_type = 2;
        while (out_frame < total_frames) {
            unsigned int nb = frames_per_window;
            if (nb > total_frames - out_frame) nb = total_frames - out_frame;
            true_peak_limiter_dev(limiter_buf, output, out_frame, nb, channels, limiter_buf_size, limiter_buf_index, attack_length, release_length, limit, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0);
            out_frame += nb;

            for (unsigned int n = 0; n < frames_per_window; n++) {
                const unsigned int src_frame = prefinal_frames + final_src_offset;
                const int have_src = final_src_offset < final_flush_frames && src_frame < total_frames;
                for (unsigned int c = 0; c < channels; c++) {
                    double v = have_src ? input[((unsigned long long)src_frame * channels) + c] * final_gain : 0.0;
                    limiter_buf[((unsigned long long)write_index * channels) + c] = v;
                }
                if (have_src) final_src_offset++;
                write_index++;
                if (write_index >= limiter_lookahead_frames) write_index = 0;
            }
            limiter_buf_index = write_index * channels;
        }
    }
}
