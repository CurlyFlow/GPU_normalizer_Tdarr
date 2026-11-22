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
