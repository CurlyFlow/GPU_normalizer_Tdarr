extern "C" __device__ double db_to_amp_dev(double db) {
    return pow(10.0, db / 20.0);
}

extern "C" __device__ double energy_to_loudness_dev(double energy) {
    if (energy <= 0.0) return -1.0 / 0.0;
    return 10.0 * log10(energy) - 0.691;
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
        result += delta[j] * weights[i];
    }
    return result;
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
            const double v0 = x - a[1] * v1 - a[2] * v2 - a[3] * v3 - a[4] * v4;
            const double y = b[0] * v0 + b[1] * v1 + b[2] * v2 + b[3] * v3 + b[4] * v4;
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
    states[c * 4 + 0] = fabs(v1) < 2.2250738585072014e-308 ? 0.0 : v1;
    states[c * 4 + 1] = fabs(v2) < 2.2250738585072014e-308 ? 0.0 : v2;
    states[c * 4 + 2] = fabs(v3) < 2.2250738585072014e-308 ? 0.0 : v3;
    states[c * 4 + 3] = fabs(v4) < 2.2250738585072014e-308 ? 0.0 : v4;
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
                const double v0 = x - a[1] * v1 - a[2] * v2 - a[3] * v3 - a[4] * v4;
                v4 = v3;
                v3 = v2;
                v2 = v1;
                v1 = v0;
            }
        }
        if (window_peak > 0.0f) atomicMax(&peak_bits[global_w], __float_as_uint(window_peak));
        q_states[q_base + 0] = fabs(v1) < 2.2250738585072014e-308 ? 0.0 : v1;
        q_states[q_base + 1] = fabs(v2) < 2.2250738585072014e-308 ? 0.0 : v2;
        q_states[q_base + 2] = fabs(v3) < 2.2250738585072014e-308 ? 0.0 : v3;
        q_states[q_base + 3] = fabs(v4) < 2.2250738585072014e-308 ? 0.0 : v4;
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
            const double v0 = x - a[1] * v1 - a[2] * v2 - a[3] * v3 - a[4] * v4;
            const double y = b[0] * v0 + b[1] * v1 + b[2] * v2 + b[3] * v3 + b[4] * v4;
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
                const double v0 = x - a[1] * v1 - a[2] * v2 - a[3] * v3 - a[4] * v4;
                v4 = v3;
                v3 = v2;
                v2 = v1;
                v1 = v0;
            }
        }
        if (window_peak > 0.0f) atomicMax(&peak_bits[global_w], __float_as_uint(window_peak));
        q_states[q_base + 0] = fabs(v1) < 2.2250738585072014e-308 ? 0.0 : v1;
        q_states[q_base + 1] = fabs(v2) < 2.2250738585072014e-308 ? 0.0 : v2;
        q_states[q_base + 2] = fabs(v3) < 2.2250738585072014e-308 ? 0.0 : v3;
        q_states[q_base + 3] = fabs(v4) < 2.2250738585072014e-308 ? 0.0 : v4;
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
            const double x = input[(unsigned long long)i * channels + c];
            const double v0 = x - a[1] * v1 - a[2] * v2 - a[3] * v3 - a[4] * v4;
            const double y = b[0] * v0 + b[1] * v1 + b[2] * v2 + b[3] * v3 + b[4] * v4;
            window_sum += y * y * weight;
            v4 = v3;
            v3 = v2;
            v2 = v1;
            v1 = v0;
        }
        if (window_sum != 0.0) atomicAdd(&sums[global_w], window_sum);
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
        0.001929064513225233,
        0.0041893491230893792,
        0.0083848200351896978,
        0.0154663675400729,
        0.02629240397422037,
        0.041192642776781981,
        0.059478006514445667,
        0.079148108748625781,
        0.097067103129731144,
        0.10971120494447859,
        0.11428185740027869,
        0.10971120494447859,
        0.097067103129731144,
        0.079148108748625781,
        0.059478006514445667,
        0.041192642776781981,
        0.02629240397422037,
        0.0154663675400729,
        0.0083848200351896978,
        0.0041893491230893792,
        0.001929064513225233,
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
    int *peak_index
) {
    *peak_delta = -1;
    int index = limiter_buf_index + (offset * channels) + (attack_length * channels);
    if (index >= limiter_buf_size) index -= limiter_buf_size;

    if (frame_type == 0) {
        for (int c = 0; c < channels; c++) {
            prev_smp[c] = fabs(buf[index + c - channels]);
        }
    }

    for (int n = 0; n < nb_samples; n++) {
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
    double *gain_reduction1
) {
    int index = (int)limiter_buf_index;
    int smp_cnt = 0;

    if (frame_type == 0) {
        double max_v = 0.0;
        for (int n = 0; n < (int)attack_length; n++) {
            for (int c = 0; c < (int)channels; c++) {
                double v = fabs(limiter_buf[n * (int)channels + c]);
                if (v > max_v) max_v = v;
            }
        }
        if (max_v > ceiling) {
            *gain_reduction1 = ceiling / max_v;
            *limiter_state = 2;
            for (int n = 0; n < (int)attack_length; n++) {
                for (int c = 0; c < (int)channels; c++) limiter_buf[n * (int)channels + c] *= *gain_reduction1;
            }
        }
    }

    do {
        if (*limiter_state == 0) {
            int peak_delta;
            double peak_value;
            detect_peak_dev(limiter_buf, (int)limiter_buf_size, (int)limiter_buf_index, smp_cnt, (int)nb_samples - smp_cnt, (int)channels, *attack_state, ceiling, frame_type, prev_smp, &peak_delta, &peak_value, peak_index);
            if (peak_delta != -1) {
                *env_cnt = 0;
                smp_cnt += peak_delta - *attack_state;
                *gain_reduction0 = 1.0;
                *gain_reduction1 = ceiling / peak_value;
                *limiter_state = 1;
                *env_index = *peak_index - (*attack_state * (int)channels);
                if (*env_index < 0) *env_index += (int)limiter_buf_size;
                *env_index += (*env_cnt * (int)channels);
                if (*env_index > (int)limiter_buf_size) *env_index -= (int)limiter_buf_size;
            } else {
                smp_cnt = (int)nb_samples;
            }
        } else if (*limiter_state == 1) {
            for (; *env_cnt < *attack_state; (*env_cnt)++) {
                for (int c = 0; c < (int)channels; c++) {
                    double env = *gain_reduction0 - ((double)(*env_cnt) / (double)((*attack_state) - 1) * (*gain_reduction0 - *gain_reduction1));
                    limiter_buf[*env_index + c] *= env;
                }
                *env_index += (int)channels;
                if (*env_index >= (int)limiter_buf_size) *env_index -= (int)limiter_buf_size;
                smp_cnt++;
                if (smp_cnt >= (int)nb_samples) {
                    (*env_cnt)++;
                    break;
                }
            }
            if (smp_cnt < (int)nb_samples) {
                *env_cnt = 0;
                *attack_state = (int)attack_length;
                *limiter_state = 2;
            }
        } else if (*limiter_state == 2) {
            int peak_delta;
            double peak_value;
            detect_peak_dev(limiter_buf, (int)limiter_buf_size, (int)limiter_buf_index, smp_cnt, (int)nb_samples, (int)channels, *attack_state, ceiling, frame_type, prev_smp, &peak_delta, &peak_value, peak_index);
            if (peak_delta == -1) {
                *limiter_state = 3;
                *gain_reduction0 = *gain_reduction1;
                *gain_reduction1 = 1.0;
                *env_cnt = 0;
            } else {
                double gain_reduction = ceiling / peak_value;
                if (gain_reduction < *gain_reduction1) {
                    *limiter_state = 1;
                    *attack_state = peak_delta;
                    if (*attack_state <= 1) *attack_state = 2;
                    *gain_reduction0 = *gain_reduction1;
                    *gain_reduction1 = gain_reduction;
                    *env_cnt = 0;
                } else {
                    for (*env_cnt = 0; *env_cnt < peak_delta; (*env_cnt)++) {
                        for (int c = 0; c < (int)channels; c++) {
                            limiter_buf[*env_index + c] *= *gain_reduction1;
                        }
                        *env_index += (int)channels;
                        if (*env_index >= (int)limiter_buf_size) *env_index -= (int)limiter_buf_size;
                        smp_cnt++;
                        if (smp_cnt >= (int)nb_samples) {
                            (*env_cnt)++;
                            break;
                        }
                    }
                }
            }
        } else {
            for (; *env_cnt < (int)release_length; (*env_cnt)++) {
                for (int c = 0; c < (int)channels; c++) {
                    double env = *gain_reduction0 + (((double)(*env_cnt) / (double)(release_length - 1)) * (*gain_reduction1 - *gain_reduction0));
                    limiter_buf[*env_index + c] *= env;
                }
                *env_index += (int)channels;
                if (*env_index >= (int)limiter_buf_size) *env_index -= (int)limiter_buf_size;
                smp_cnt++;
                if (smp_cnt >= (int)nb_samples) {
                    (*env_cnt)++;
                    break;
                }
            }
            if (smp_cnt < (int)nb_samples) {
                *env_cnt = 0;
                *limiter_state = 0;
            }
        }
    } while (smp_cnt < (int)nb_samples);

    for (unsigned int n = 0; n < nb_samples; n++) {
        for (unsigned int c = 0; c < channels; c++) {
            double out = limiter_buf[index + (int)c];
            if (fabs(out) > ceiling) out = ceiling * (out < 0.0 ? -1.0 : 1.0);
            output[((unsigned long long)(output_frame_offset + n) * channels) + c] = out;
        }
        index += channels;
        if (index >= (int)limiter_buf_size) index -= (int)limiter_buf_size;
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
            const double v0 = x - a[1] * v1 - a[2] * v2 - a[3] * v3 - a[4] * v4;
            const double y = b[0] * v0 + b[1] * v1 + b[2] * v2 + b[3] * v3 + b[4] * v4;
            frame_sum += y * y * ebur_slot_weight_dev(slot);
            state_d[base + 3] = v3;
            state_d[base + 2] = v2;
            state_d[base + 1] = v1;
            state_d[base + 0] = fabs(v0) < 2.2250738585072014e-308 ? 0.0 : v0;
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
            double v0 = x - a[1] * v1 - a[2] * v2 - a[3] * v3 - a[4] * v4;
            double y = b[0] * v0 + b[1] * v1 + b[2] * v2 + b[3] * v3 + b[4] * v4;
            frame_sum += y * y * ebur_slot_weight_dev(slot);
            out_states[base + 3] = v3;
            out_states[base + 2] = v2;
            out_states[base + 1] = v1;
            out_states[base + 0] = fabs(v0) < 2.2250738585072014e-308 ? 0.0 : v0;
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
    unsigned int *state_i
) {
    if (frame >= total_frames) return 0.0;
    if (frame < input_base_frame || frame >= input_base_frame + input_frames) {
        state_i[FB_I_INPUT_MISSING] = 1;
        return 0.0;
    }
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
        0.001929064513225233,
        0.0041893491230893792,
        0.0083848200351896978,
        0.0154663675400729,
        0.02629240397422037,
        0.041192642776781981,
        0.059478006514445667,
        0.079148108748625781,
        0.097067103129731144,
        0.10971120494447859,
        0.11428185740027869,
        0.10971120494447859,
        0.097067103129731144,
        0.079148108748625781,
        0.059478006514445667,
        0.041192642776781981,
        0.02629240397422037,
        0.0154663675400729,
        0.0083848200351896978,
        0.0041893491230893792,
        0.001929064513225233,
    };
    double *short_ring = state_d + FB_D_SHORT_RING;
    double *out_short_ring = state_d + FB_D_OUT_SHORT_RING;
    double *delta = state_d + FB_D_DELTA;
    double *out_states = state_d + FB_D_OUT_STATES;

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
        double init_gain = init_delta * offset_amp;
        for (int i = 0; i < 30; i++) delta[i] = init_delta;
        for (unsigned int c = 0; c < channels; c++) prev_smp[c] = 0.0;
        for (unsigned int n = 0; n < limiter_lookahead_frames; n++) {
            for (unsigned int c = 0; c < channels; c++) {
                double v = feedback_input_sample_dev(input, input_base_frame, input_frames, total_frames, n, c, channels, state_i) * init_gain;
                limiter_buf[((unsigned long long)n * channels) + c] = v;
            }
        }
        state_d[FB_D_SHORT_SUM] = short_sum;
        state_d[FB_D_PREV_DELTA] = delta[1];
        state_i[FB_I_SHORT_INDEX] = short_index;
        state_i[FB_I_SHORT_COUNT] = short_count;
        state_i[FB_I_ABOVE_THRESHOLD] = above_threshold;
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
                const double final_gain = gaussian_filter_dev(delta, weights, (index + 10) < 30 ? (index + 10) : (index + 10 - 30)) * offset_amp;
                write_index = 0;
                for (unsigned int n = 0; n < limiter_lookahead_frames; n++) {
                    const unsigned int src_frame = prefinal_frames + n;
                    for (unsigned int c = 0; c < channels; c++) {
                        double v = feedback_input_sample_dev(input, input_base_frame, input_frames, total_frames, src_frame, c, channels, state_i) * final_gain;
                        limiter_buf[((unsigned long long)n * channels) + c] = v;
                    }
                }
                final_src_offset = limiter_lookahead_frames;
                frame_type = 2;
                final_initialized = 1;
            }
            unsigned int nb = frames_per_window;
            if (nb > total_frames - out_frame) nb = total_frames - out_frame;
            if (nb > output_frames - produced) nb = output_frames - produced;
            true_peak_limiter_dev(limiter_buf, output, produced, nb, channels, limiter_buf_size, write_index * channels, attack_length, release_length, ceiling, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1);
            out_frame += nb;
            produced += nb;

            const double final_gain = gaussian_filter_dev(delta, weights, (index + 10) < 30 ? (index + 10) : (index + 10 - 30)) * offset_amp;
            for (unsigned int n = 0; n < frames_per_window; n++) {
                const unsigned int src_frame = prefinal_frames + final_src_offset;
                const int have_src = final_src_offset < final_flush_frames && src_frame < total_frames;
                for (unsigned int c = 0; c < channels; c++) {
                    double v = have_src ? feedback_input_sample_dev(input, input_base_frame, input_frames, total_frames, src_frame, c, channels, state_i) * final_gain : 0.0;
                    limiter_buf[((unsigned long long)write_index * channels) + c] = v;
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
            for (unsigned int n = 0; n < nb; n++) {
                double interp = nb > 0 ? (double)n / (double)nb : 0.0;
                double timed_gain = (gain + interp * (gain_next - gain)) * offset_amp;
                for (unsigned int c = 0; c < channels; c++) {
                    double v = feedback_input_sample_dev(input, input_base_frame, input_frames, total_frames, write_frame, c, channels, state_i) * timed_gain;
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
        }
        true_peak_limiter_dev(limiter_buf, output, produced, nb, channels, limiter_buf_size, write_index * channels, attack_length, release_length, ceiling, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1);
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
        0.001929064513225233,
        0.0041893491230893792,
        0.0083848200351896978,
        0.0154663675400729,
        0.02629240397422037,
        0.041192642776781981,
        0.059478006514445667,
        0.079148108748625781,
        0.097067103129731144,
        0.10971120494447859,
        0.11428185740027869,
        0.10971120494447859,
        0.097067103129731144,
        0.079148108748625781,
        0.059478006514445667,
        0.041192642776781981,
        0.02629240397422037,
        0.0154663675400729,
        0.0083848200351896978,
        0.0041893491230893792,
        0.001929064513225233,
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
        true_peak_limiter_dev(limiter_buf, output, out_frame, nb, channels, limiter_buf_size, limiter_buf_index, attack_length, release_length, ceiling, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1);
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
            true_peak_limiter_dev(limiter_buf, output, out_frame, nb, channels, limiter_buf_size, limiter_buf_index, attack_length, release_length, ceiling, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1);
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
        true_peak_limiter_dev(limiter_buf, output, out_frame, nb, channels, limiter_buf_size, limiter_buf_index, attack_length, release_length, limit, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1);
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
            true_peak_limiter_dev(limiter_buf, output, out_frame, nb, channels, limiter_buf_size, limiter_buf_index, attack_length, release_length, limit, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1);
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
