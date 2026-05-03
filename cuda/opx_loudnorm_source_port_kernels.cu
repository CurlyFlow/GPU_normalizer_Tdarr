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
    float weight = 1.0f;
    if (channels == 6 && c >= 4) weight = 1.41f;
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
            window_sum += (float)(y * y * (double)weight);
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
    const unsigned int local_w = blockIdx.x;
    const unsigned int c = blockIdx.y;
    if (c >= channels || threadIdx.x != 0) return;
    const unsigned int start = local_w * frames_per_window;
    if (start >= frames) return;
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

extern "C" __global__ void kweight_window_sums_kernel(
    const float *input,
    float *sums,
    const double *start_states,
    unsigned int frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int global_window_offset,
    const double *b,
    const double *a
) {
    const unsigned int local_w = blockIdx.x;
    const unsigned int c = blockIdx.y;
    if (c >= channels || threadIdx.x != 0) return;
    const int mapped_unused = (channels == 6 && c == 3);
    if (mapped_unused) return;
    const unsigned int start = local_w * frames_per_window;
    if (start >= frames) return;
    unsigned int end = start + frames_per_window;
    if (end > frames) end = frames;
    const unsigned int global_w = global_window_offset + local_w;
    const unsigned long long state_base = ((unsigned long long)global_w * channels + c) * 4ULL;
    float weight = 1.0f;
    if (channels == 6 && c >= 4) weight = 1.41f;
    double v1 = start_states[state_base + 0];
    double v2 = start_states[state_base + 1];
    double v3 = start_states[state_base + 2];
    double v4 = start_states[state_base + 3];
    float window_sum = 0.0f;
    for (unsigned int i = start; i < end; i++) {
        const float x_f = input[(unsigned long long)i * channels + c];
        const double x = (double)x_f;
        const double v0 = x - a[1] * v1 - a[2] * v2 - a[3] * v3 - a[4] * v4;
        const double y = b[0] * v0 + b[1] * v1 + b[2] * v2 + b[3] * v3 + b[4] * v4;
        window_sum += (float)(y * y * (double)weight);
        v4 = v3;
        v3 = v2;
        v2 = v1;
        v1 = v0;
    }
    if (window_sum != 0.0f) atomicAdd(&sums[global_w], window_sum);
}

extern "C" __global__ void source_port_gain_kernel(
    const float *window_sums,
    const unsigned int *peak_bits,
    float *gains,
    unsigned int windows,
    unsigned int frames_per_window,
    float target_i,
    float target_lra,
    float target_tp,
    const double *hist_energies
) {
    if (blockIdx.x != 0 || threadIdx.x != 0) return;
    unsigned int hist[1000];
    for (int i = 0; i < 1000; i++) hist[i] = 0;
    double weights[21];
    double total_weight = 0.0;
    const double sigma = 3.5;
    for (int i = 0; i < 21; i++) {
        const int x = i - 10;
        weights[i] = exp(-((double)(x * x) / (2.0 * sigma * sigma)));
        total_weight += weights[i];
    }
    for (int i = 0; i < 21; i++) weights[i] /= total_weight;

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
    const double measured_i = 0.0;
    const double measured_thresh = -70.0;
    const double target_tp_amp = db_to_amp_dev((double)target_tp);

    for (unsigned int i = 0; i < windows; i++) gains[i] = 1.0f;
    const unsigned int first = windows < 30 ? windows : 30;
    for (unsigned int t = 0; t < first; t++) {
        if (short_count == 30) short_sum -= short_ring[short_index]; else short_count++;
        short_ring[short_index] = (double)window_sums[t];
        short_sum += (double)window_sums[t];
        short_index = (short_index + 1) % 30;
        if (t >= 3) {
            double e = ((double)window_sums[t] + (double)window_sums[t - 1] + (double)window_sums[t - 2] + (double)window_sums[t - 3]) / (double)(frames_per_window * 4);
            if (energy_to_loudness_dev(e) >= -70.0) hist[hist_index_from_energy_dev(e)]++;
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
        gains[0] = (float)delta[index];
        out_short_ring[out_short_index] = (double)window_sums[0] * delta[index] * delta[index];
        out_short_sum += out_short_ring[out_short_index];
        out_short_index = (out_short_index + 1) % 30;
        out_short_count = 1;
    }

    unsigned int out_idx = 1;
    for (unsigned int t = 30; t < windows; t++) {
        double gain = gaussian_filter_dev(delta, weights, (index + 10) < 30 ? (index + 10) : (index + 10 - 30));
        if (out_idx < windows) {
            gains[out_idx] = (float)gain;
            if (out_short_count == 30) out_short_sum -= out_short_ring[out_short_index]; else out_short_count++;
            out_short_ring[out_short_index] = (double)window_sums[out_idx] * gain * gain;
            out_short_sum += out_short_ring[out_short_index];
            out_short_index = (out_short_index + 1) % 30;
            out_idx++;
        }

        if (short_count == 30) short_sum -= short_ring[short_index]; else short_count++;
        short_ring[short_index] = (double)window_sums[t];
        short_sum += (double)window_sums[t];
        short_index = (short_index + 1) % 30;
        double e = ((double)window_sums[t] + (double)window_sums[t - 1] + (double)window_sums[t - 2] + (double)window_sums[t - 3]) / (double)(frames_per_window * 4);
        if (energy_to_loudness_dev(e) >= -70.0) hist[hist_index_from_energy_dev(e)]++;

        const double global = gated_loudness_lut_dev(hist, hist_energies);
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
    while (out_idx < windows) gains[out_idx++] = (float)final_gain;

    for (unsigned int i = 0; i < windows; i++) {
        float peak = __uint_as_float(peak_bits[i]);
        if (peak > 1e-9f) {
            float ceiling_gain = target_tp_amp / peak;
            if (gains[i] > ceiling_gain) gains[i] = ceiling_gain;
        }
        if (gains[i] < 0.0f) gains[i] = 0.0f;
    }
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
