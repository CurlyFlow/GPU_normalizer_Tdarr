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

static __device__ __forceinline__ int loudnorm_channel_slot_for_stats(unsigned int channels, unsigned int c) {
    if (channels == 4U) {
        if (c == 0U) return 0;
        if (c == 1U) return 1;
        if (c == 2U) return 3;
        if (c == 3U) return 4;
        return -1;
    }
    if (channels == 5U) {
        if (c == 0U) return 0;
        if (c == 1U) return 1;
        if (c == 2U) return 2;
        if (c == 3U) return 3;
        if (c == 4U) return 4;
        return -1;
    }
    if (c == 0U) return 0;
    if (c == 1U) return 1;
    if (c == 2U) return 2;
    if (c == 4U) return 3;
    if (c == 5U) return 4;
    return -1;
}

extern "C" __global__ void kweight_window_sums_f64_paired_combined_kernel(
    const double *input,
    double *primary_channel_sums,
    unsigned int *primary_peak_bits,
    double *primary_states,
    double *primary_source_start_states,
    double *partner_channel_sums,
    unsigned int *partner_peak_bits,
    double *partner_states,
    double *partner_source_start_states,
    unsigned int frames,
    unsigned int primary_channels,
    unsigned int partner_channels,
    unsigned int input_channels,
    unsigned int partner_channel_offset,
    unsigned int frames_per_window,
    unsigned int global_frame_offset,
    const double *b,
    const double *a
) {
    if (blockIdx.x != 0U) return;
    const unsigned int out_c = threadIdx.x;
    const int is_partner = out_c >= primary_channels;
    const unsigned int channels = is_partner ? partner_channels : primary_channels;
    const unsigned int c = is_partner ? (out_c - primary_channels) : out_c;
    if (out_c >= primary_channels + partner_channels || c >= channels || frames_per_window == 0U) return;
    const unsigned int channel_offset = is_partner ? partner_channel_offset : 0U;
    if (channel_offset + c >= input_channels) return;

    double *channel_sums = is_partner ? partner_channel_sums : primary_channel_sums;
    unsigned int *peak_bits = is_partner ? partner_peak_bits : primary_peak_bits;
    double *states = is_partner ? partner_states : primary_states;
    double *source_start_states = is_partner ? partner_source_start_states : primary_source_start_states;
    if (!channel_sums || !states) return;

    const int slot = loudnorm_channel_slot_for_stats(channels, c);
    if (slot < 0) {
        if (!peak_bits) return;
        unsigned int current_w = global_frame_offset / frames_per_window;
        unsigned int window_peak_bits = 0U;
        for (unsigned int i = 0; i < frames; i++) {
            const unsigned int w = (global_frame_offset + i) / frames_per_window;
            if (w != current_w) {
                if (window_peak_bits != 0U) atomicMax(&peak_bits[current_w], window_peak_bits);
                current_w = w;
                window_peak_bits = 0U;
            }
            const double x = input[((unsigned long long)i * input_channels) + channel_offset + c];
            const unsigned int bits = __float_as_uint((float)fabs(x));
            if (bits > window_peak_bits) window_peak_bits = bits;
        }
        if (frames > 0U && window_peak_bits != 0U) atomicMax(&peak_bits[current_w], window_peak_bits);
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
                const double x = input[((unsigned long long)i * input_channels) + channel_offset + c];
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
        const double x = input[((unsigned long long)i * input_channels) + channel_offset + c];
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
    if (frames > 0U) {
        if (peak_bits && window_peak_bits != 0U) atomicMax(&peak_bits[current_w], window_peak_bits);
        channel_sums[((unsigned long long)current_w * channels) + c] = window_sum;
    }
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
