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

extern "C" __global__ void kweight_window_channel_sums_f64_prefix_unroll4_kernel(
    const double *__restrict__ input,
    double *__restrict__ channel_sums,
    const double *__restrict__ start_states,
    unsigned int frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int global_window_offset,
    const double *__restrict__ b,
    const double *__restrict__ a
) {
    const unsigned int local_windows = (frames + frames_per_window - 1U) / frames_per_window;
    const unsigned int pairs = local_windows * channels;
    const unsigned int stride = blockDim.x * gridDim.x;
    const double a1 = a[1];
    const double a2 = a[2];
    const double a3 = a[3];
    const double a4 = a[4];
    const double b0 = b[0];
    const double b1 = b[1];
    const double b2 = b[2];
    const double b3 = b[3];
    const double b4 = b[4];
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
        const unsigned long long state_base = ((unsigned long long)global_w * channels + c) * 4ULL;
        double v1 = start_states[state_base + 0ULL];
        double v2 = start_states[state_base + 1ULL];
        double v3 = start_states[state_base + 2ULL];
        double v4 = start_states[state_base + 3ULL];
        const double weight = slot >= 3 ? 1.41 : 1.0;
        double window_sum = 0.0;
        const double *sample_ptr = input + ((unsigned long long)start * channels) + c;
        unsigned int i = start;
#define LOUDNORM_PREFIX_CHANNEL_UNROLL4_STEP() \
        do { \
            const double x = *sample_ptr; \
            double v0 = x; \
            v0 = __dsub_rn(v0, __dmul_rn(a1, v1)); \
            v0 = __dsub_rn(v0, __dmul_rn(a2, v2)); \
            v0 = __dsub_rn(v0, __dmul_rn(a3, v3)); \
            v0 = __dsub_rn(v0, __dmul_rn(a4, v4)); \
            double y = __dmul_rn(b0, v0); \
            y = __dadd_rn(y, __dmul_rn(b1, v1)); \
            y = __dadd_rn(y, __dmul_rn(b2, v2)); \
            y = __dadd_rn(y, __dmul_rn(b3, v3)); \
            y = __dadd_rn(y, __dmul_rn(b4, v4)); \
            window_sum += y * y * weight; \
            v4 = v3; \
            v3 = v2; \
            v2 = v1; \
            v1 = v0; \
            sample_ptr += channels; \
        } while (0)
        for (; i + 4U <= end; i += 4U) {
            LOUDNORM_PREFIX_CHANNEL_UNROLL4_STEP();
            LOUDNORM_PREFIX_CHANNEL_UNROLL4_STEP();
            LOUDNORM_PREFIX_CHANNEL_UNROLL4_STEP();
            LOUDNORM_PREFIX_CHANNEL_UNROLL4_STEP();
        }
        for (; i < end; i++) {
            LOUDNORM_PREFIX_CHANNEL_UNROLL4_STEP();
        }
#undef LOUDNORM_PREFIX_CHANNEL_UNROLL4_STEP
        channel_sums[((unsigned long long)global_w * channels) + c] = window_sum;
    }
}

extern "C" __global__ void kweight_window_checkpoint_states_f64_channel_kernel(
    const double *input,
    unsigned int *peak_bits,
    double *states,
    double *checkpoint_states,
    double *source_start_states,
    unsigned int frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int global_frame_offset,
    const double *a
) {
    const unsigned int c = blockIdx.x;
    if (c >= channels || threadIdx.x != 0 || frames_per_window == 0U) return;
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
            const unsigned int bits = __float_as_uint((float)fabs(input[(unsigned long long)i * channels + c]));
            if (bits > window_peak_bits) window_peak_bits = bits;
        }
        if (frames > 0U && window_peak_bits != 0U) atomicMax(&peak_bits[current_w], window_peak_bits);
        return;
    }

    const double a1 = a[1];
    const double a2 = a[2];
    const double a3 = a[3];
    const double a4 = a[4];
    double v1 = states[c * 4 + 0];
    double v2 = states[c * 4 + 1];
    double v3 = states[c * 4 + 2];
    double v4 = states[c * 4 + 3];
    unsigned int current_w = global_frame_offset / frames_per_window;
    unsigned int window_peak_bits = 0U;

    if (frames > 0U) {
        const unsigned long long state_base = ((unsigned long long)current_w * channels + c) * 4ULL;
        checkpoint_states[state_base + 0] = v1;
        checkpoint_states[state_base + 1] = v2;
        checkpoint_states[state_base + 2] = v3;
        checkpoint_states[state_base + 3] = v4;
        if (source_start_states && channels == 2U) {
            source_start_states[state_base + 0] = v1;
            source_start_states[state_base + 1] = v2;
            source_start_states[state_base + 2] = v3;
            source_start_states[state_base + 3] = v4;
        }
    }

    for (unsigned int i = 0; i < frames; i++) {
        const unsigned int w = (global_frame_offset + i) / frames_per_window;
        if (w != current_w) {
            if (peak_bits && window_peak_bits != 0U) atomicMax(&peak_bits[current_w], window_peak_bits);
            current_w = w;
            window_peak_bits = 0U;
            const unsigned long long state_base = ((unsigned long long)current_w * channels + c) * 4ULL;
            checkpoint_states[state_base + 0] = v1;
            checkpoint_states[state_base + 1] = v2;
            checkpoint_states[state_base + 2] = v3;
            checkpoint_states[state_base + 3] = v4;
            if (source_start_states && channels == 2U) {
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
        v4 = v3;
        v3 = v2;
        v2 = v1;
        v1 = v0;
    }
    if (frames > 0U && peak_bits && window_peak_bits != 0U) atomicMax(&peak_bits[current_w], window_peak_bits);
    states[c * 4 + 0] = v1;
    states[c * 4 + 1] = v2;
    states[c * 4 + 2] = v3;
    states[c * 4 + 3] = v4;
}
