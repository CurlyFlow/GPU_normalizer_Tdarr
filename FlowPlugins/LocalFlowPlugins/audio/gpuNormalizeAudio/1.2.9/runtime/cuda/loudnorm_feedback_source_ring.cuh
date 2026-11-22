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
