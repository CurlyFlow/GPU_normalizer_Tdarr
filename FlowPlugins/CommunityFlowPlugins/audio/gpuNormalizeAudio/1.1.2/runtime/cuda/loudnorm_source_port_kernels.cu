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

extern "C" __global__ void kweight_window_sums_f64_channel_kernel(
    const double *input,
    double *channel_sums,
    unsigned int *peak_bits,
    double *states,
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
    const double weight = slot >= 3 ? 1.41 : 1.0;
    double v1 = states[c * 4 + 0];
    double v2 = states[c * 4 + 1];
    double v3 = states[c * 4 + 2];
    double v4 = states[c * 4 + 3];
    unsigned int current_w = global_frame_offset / frames_per_window;
    double window_sum = 0.0;
    float window_peak = 0.0f;
    for (unsigned int i = 0; i < frames; i++) {
        const unsigned int w = (global_frame_offset + i) / frames_per_window;
        if (w != current_w) {
            if (window_peak > 0.0f) atomicMax(&peak_bits[current_w], __float_as_uint(window_peak));
            if (slot >= 0) channel_sums[((unsigned long long)current_w * channels) + c] = window_sum;
            current_w = w;
            window_sum = 0.0;
            window_peak = 0.0f;
        }
        const double x = input[(unsigned long long)i * channels + c];
        const float ax = (float)fabs(x);
        if (ax > window_peak) window_peak = ax;
        if (slot >= 0) {
            const double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
            const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
            window_sum += y * y * weight;
            v4 = v3;
            v3 = v2;
            v2 = v1;
            v1 = v0;
        }
    }
    if (frames > 0) {
        if (window_peak > 0.0f) atomicMax(&peak_bits[current_w], __float_as_uint(window_peak));
        if (slot >= 0) channel_sums[((unsigned long long)current_w * channels) + c] = window_sum;
    }
    states[c * 4 + 0] = v1;
    states[c * 4 + 1] = v2;
    states[c * 4 + 2] = v3;
    states[c * 4 + 3] = v4;
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
    int limiter_maybe_above_ceiling
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

    const int skip_peak_detection = !LOUDNORM_EXACT_GENERIC_LIMITER && channels == 6U && limiter_state_work == 0 && limiter_maybe_above_ceiling <= 0;
    if (skip_peak_detection) {
        int scan_index = (int)limiter_buf_index + ((int)attack_length * (int)channels);
        while (scan_index >= (int)limiter_buf_size) scan_index -= (int)limiter_buf_size;
        if (frame_type == 0) {
            int prev_index = scan_index - (int)channels;
            if (prev_index < 0) prev_index += (int)limiter_buf_size;
            for (int c = 0; c < (int)channels; c++) {
                prev_smp_work[c] = fabs(limiter_buf[prev_index + c]);
            }
        }
        for (unsigned int n = 0; n < nb_samples; n++) {
            for (int c = 0; c < (int)channels; c++) {
                prev_smp_work[c] = fabs(limiter_buf[scan_index + c]);
            }
            scan_index += (int)channels;
            if (scan_index >= (int)limiter_buf_size) scan_index -= (int)limiter_buf_size;
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

    if (limiter_maybe_above_ceiling < 0 && !feedback_enabled && channels == 6U && limiter_state_work == 0) {
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
                    frame_sum += y * y * (slot >= 3 ? 1.41 : 1.0);
                    out_states_work[base + 3] = v3;
                    out_states_work[base + 2] = v2;
                    out_states_work[base + 1] = v1;
                    out_states_work[base + 0] = v0;
                }
            }
        }
        if (feedback_enabled) {
            *out_window_sum += frame_sum;
            (*out_window_count)++;
            if (*out_window_count == frames_per_window) {
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
        index += channels;
        if (index >= (int)limiter_buf_size) index -= (int)limiter_buf_size;
    }
    if (feedback_enabled) {
        for (int i = 0; i < 20; i++) out_states[i] = out_states_work[i];
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

extern "C" __global__ void apply_plan_f64_io_ffmpeg_feedback_limiter_stream_kernel(
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
    double ceiling
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
    double *profile_counts = state_i[FB_I_PROFILE_COUNTS] ? state_d : 0;

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

        unsigned int short_count = 0;
        unsigned int short_index = 0;
        double short_sum = 0.0;
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
            true_peak_limiter_dev(limiter_buf, output, produced, nb, channels, limiter_buf_size, write_index * channels, attack_length, release_length, ceiling, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, profile_counts, final_limiter_flag);
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
        if (!first) {
            double gain = gaussian_filter_dev(delta, weights, (index + 10) < 30 ? (index + 10) : (index + 10 - 30));
            double gain_next = gaussian_filter_dev(delta, weights, (index + 11) < 30 ? (index + 11) : (index + 11 - 30));
            const double gain_diff = gain_next - gain;
            for (unsigned int n = 0; n < nb; n++) {
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
        int normal_limiter_flag = (state_i[FB_I_PREFILLED_OUTPUT] && state_i[FB_I_PREFILL_CHUNK_SAFE] && above_threshold != 0) ? -1 : limiter_maybe_above_ceiling;
        true_peak_limiter_dev(limiter_buf, output, produced, nb, channels, limiter_buf_size, write_index * channels, attack_length, release_length, ceiling, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, profile_counts, normal_limiter_flag);
        add_feedback_output_dev(output, produced, nb, channels, frames_per_window, b, a, out_states, out_short_ring, &out_short_sum, &out_short_index, &out_short_count, &out_window_sum, &out_window_count);
        out_frame += nb;
        produced += nb;
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
        const double shortterm = energy_to_loudness_dev(short_sum / (double)(frames_per_window * 30));
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
        true_peak_limiter_dev(limiter_buf, output, out_frame, nb, channels, limiter_buf_size, limiter_buf_index, attack_length, release_length, ceiling, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
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
            true_peak_limiter_dev(limiter_buf, output, out_frame, nb, channels, limiter_buf_size, limiter_buf_index, attack_length, release_length, ceiling, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
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
        true_peak_limiter_dev(limiter_buf, output, out_frame, nb, channels, limiter_buf_size, limiter_buf_index, attack_length, release_length, limit, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
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
            true_peak_limiter_dev(limiter_buf, output, out_frame, nb, channels, limiter_buf_size, limiter_buf_index, attack_length, release_length, limit, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
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
