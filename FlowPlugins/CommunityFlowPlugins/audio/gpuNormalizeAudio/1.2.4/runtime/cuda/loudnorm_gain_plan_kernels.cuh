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
