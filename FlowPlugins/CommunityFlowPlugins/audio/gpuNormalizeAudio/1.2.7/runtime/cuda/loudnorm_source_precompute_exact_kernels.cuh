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

static __device__ double source_stereo_exact_short_total_raw_f64_dev(
    const double *input,
    const double *source_start_states,
    unsigned int total_frames,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int frames_per_window,
    unsigned int window,
    const double *b,
    const double *a
) {
    const unsigned int end_window = window + 1U;
    const unsigned int short_count = end_window < 30U ? end_window : 30U;
    const unsigned int short_start_window = end_window - short_count;
    const unsigned int start_frame = short_start_window * frames_per_window;
    unsigned int end_frame = end_window * frames_per_window;
    if (end_frame > total_frames || end_frame < start_frame) end_frame = total_frames;
    double short_total = 0.0;
    for (unsigned int c = 0; c < 2U; c++) {
        const unsigned long long state_base = ((unsigned long long)short_start_window * 2ULL + c) * 4ULL;
        double v1 = source_start_states[state_base + 0];
        double v2 = source_start_states[state_base + 1];
        double v3 = source_start_states[state_base + 2];
        double v4 = source_start_states[state_base + 3];
        double channel_short = 0.0;
        for (unsigned int frame = start_frame; frame < end_frame; frame++) {
            const double x = (frame >= input_base_frame && frame < input_base_frame + input_frames) ? input[((unsigned long long)(frame - input_base_frame) * 2ULL) + c] : 0.0;
            const double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
            const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
            channel_short += y * y;
            v4 = v3;
            v3 = v2;
            v2 = v1;
            v1 = v0;
        }
        short_total += channel_short;
    }
    return short_total;
}

extern "C" __global__ void source_stereo_selective_short_raw_sums_f64_kernel(
    const double *input,
    const double *source_start_states,
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
    const double *b,
    const double *a,
    double measured_thresh,
    double margin_lu,
    unsigned int halo_windows
) {
    if (blockIdx.x != 0U || threadIdx.x != 0U) return;
    if (channels != 2U || !input || !source_start_states || !source_exact_sums || !channel_sums || !hist_energies || !hist_boundaries || frames_per_window == 0U) return;
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
            source_exact_sums[((unsigned long long)w * 3ULL) + 2ULL] = source_stereo_exact_short_total_raw_f64_dev(
                input,
                source_start_states,
                total_frames,
                input_base_frame,
                input_frames,
                frames_per_window,
                w,
                b,
                a
            );
        }
        corrected_until = end_window;
    }
}

extern "C" __global__ void source_stereo_mark_short_raw_corrections_f64_kernel(
    double *source_exact_sums,
    unsigned int *correction_flags,
    const double *channel_sums,
    const double *hist_energies,
    const double *hist_boundaries,
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
    if (channels != 2U || !source_exact_sums || !correction_flags || !channel_sums || !hist_energies || !hist_boundaries || frames_per_window == 0U) return;
    unsigned int target_end_window = target_start_window + target_windows;
    if (target_end_window > windows || target_end_window < target_start_window) target_end_window = windows;
    if (target_start_window >= target_end_window) return;

    for (unsigned int t = target_start_window; t < target_end_window; t++) {
        source_exact_sums[((unsigned long long)t * 3ULL) + 2ULL] = source_stereo_channel_short_total_f64_dev(channel_sums, windows, t);
        correction_flags[t] = 0U;
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
            correction_flags[w] = 1U;
        }
        corrected_until = end_window;
    }
}

extern "C" __global__ void source_stereo_apply_short_raw_corrections_f64_kernel(
    const double *input,
    const double *source_start_states,
    double *source_exact_sums,
    const unsigned int *correction_flags,
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
    if (channels != 2U || !input || !source_start_states || !source_exact_sums || !correction_flags || frames_per_window == 0U) return;
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int local = blockIdx.x * blockDim.x + threadIdx.x; local < target_windows; local += stride) {
        const unsigned int t = target_start_window + local;
        if (t >= windows || !correction_flags[t]) continue;
        source_exact_sums[((unsigned long long)t * 3ULL) + 2ULL] = source_stereo_exact_short_total_raw_f64_dev(
            input,
            source_start_states,
            total_frames,
            input_base_frame,
            input_frames,
            frames_per_window,
            t,
            b,
            a
        );
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
