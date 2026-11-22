#define OPX_FFMPEG_STATE_AUDIT_EVENT_INIT 1U
#define OPX_FFMPEG_STATE_AUDIT_EVENT_LIMITER_BEFORE 2U
#define OPX_FFMPEG_STATE_AUDIT_EVENT_LIMITER_AFTER 3U
#define OPX_FFMPEG_STATE_AUDIT_EVENT_DELTA_AFTER 4U
#define OPX_FFMPEG_STATE_AUDIT_EVENT_FINAL_FLUSH_START 5U
#define OPX_FFMPEG_STATE_AUDIT_EVENT_FINAL_FLUSH_END 6U
#define OPX_FFMPEG_STATE_AUDIT_I_WORDS 25U
#define OPX_FFMPEG_STATE_AUDIT_D_WORDS 38U

extern "C" __device__ void opx_write_ffmpeg_state_audit_dev(
    unsigned int *audit_i,
    double *audit_d,
    unsigned int audit_max_events,
    unsigned int audit_sample_windows,
    unsigned int event_code,
    int frame_type,
    unsigned int frame,
    unsigned int total_frames,
    unsigned int output_frames,
    unsigned int input_window,
    unsigned int out_frame,
    unsigned int write_frame,
    unsigned int write_index,
    unsigned int short_index,
    unsigned int short_count,
    int out_short_index,
    int out_short_count,
    unsigned int out_window_count,
    int delta_index,
    int above_threshold,
    int limiter_state,
    int peak_index,
    int env_index,
    int env_cnt,
    int attack_state,
    int first,
    int final_initialized,
    unsigned int final_src_offset,
    int limiter_maybe_above_ceiling,
    double short_sum,
    double out_short_sum,
    double out_window_sum,
    double prev_delta,
    double gain_reduction0,
    double gain_reduction1,
    const double *delta_values,
    const double *state_d
) {
    if (!audit_i || !audit_d || audit_max_events == 0U) return;
    if (audit_sample_windows > 1U && event_code != OPX_FFMPEG_STATE_AUDIT_EVENT_INIT && event_code != OPX_FFMPEG_STATE_AUDIT_EVENT_FINAL_FLUSH_START && event_code != OPX_FFMPEG_STATE_AUDIT_EVENT_FINAL_FLUSH_END) {
        if ((input_window % audit_sample_windows) != 0U) return;
    }
    const unsigned int record_index = audit_i[0];
    if (record_index >= audit_max_events) return;
    audit_i[0] = record_index + 1U;

    unsigned int *ri = audit_i + 1U + ((unsigned long long)record_index * OPX_FFMPEG_STATE_AUDIT_I_WORDS);
    double *rd = audit_d + ((unsigned long long)record_index * OPX_FFMPEG_STATE_AUDIT_D_WORDS);
    ri[0] = event_code;
    ri[1] = (unsigned int)frame_type;
    ri[2] = frame;
    ri[3] = total_frames;
    ri[4] = output_frames;
    ri[5] = input_window;
    ri[6] = out_frame;
    ri[7] = write_frame;
    ri[8] = write_index;
    ri[9] = short_index;
    ri[10] = short_count;
    ri[11] = (unsigned int)out_short_index;
    ri[12] = (unsigned int)out_short_count;
    ri[13] = out_window_count;
    ri[14] = (unsigned int)delta_index;
    ri[15] = (unsigned int)above_threshold;
    ri[16] = (unsigned int)limiter_state;
    ri[17] = (unsigned int)peak_index;
    ri[18] = (unsigned int)env_index;
    ri[19] = (unsigned int)env_cnt;
    ri[20] = (unsigned int)attack_state;
    ri[21] = (unsigned int)first;
    ri[22] = (unsigned int)final_initialized;
    ri[23] = final_src_offset;
    ri[24] = (unsigned int)limiter_maybe_above_ceiling;

    rd[0] = short_sum;
    rd[1] = out_short_sum;
    rd[2] = out_window_sum;
    rd[3] = prev_delta;
    rd[4] = gain_reduction0;
    rd[5] = gain_reduction1;
    rd[6] = state_d[FB_D_SOURCE_OUT_WINDOW_SUM0];
    rd[7] = state_d[FB_D_SOURCE_OUT_WINDOW_SUM1];
    for (int i = 0; i < 30; i++) rd[8 + i] = delta_values ? delta_values[i] : state_d[FB_D_DELTA + i];
}

extern "C" __global__ void apply_plan_f64_io_ffmpeg_feedback_limiter_stream_kernel(
    const double *input,
    double *output,
    const double *window_sums,
    const double *source_channel_sums,
    double *source_short_ring,
    double *output_window_sums,
    unsigned int *output_metric_state_i,
    double *output_metric_state_d,
    const double *hist_energies,
    const double *hist_boundaries,
    double *limiter_buf,
    double *prev_smp,
    unsigned int *state_i,
    double *state_d,
    unsigned int *hist,
    unsigned int *audit_i,
    double *audit_d,
    unsigned int audit_max_events,
    unsigned int audit_sample_windows,
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

    int just_initialized = 0;
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
        just_initialized = 1;
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
    const int force_safe_idle_raw = (int)state_i[FB_I_FORCE_SAFE_IDLE];
    const int force_safe_idle = force_safe_idle_raw == 1;
    const int host_r128_owner_after_threshold = force_safe_idle_raw == 2;
    double short_sum = state_d[FB_D_SHORT_SUM];
    double out_short_sum = state_d[FB_D_OUT_SHORT_SUM];
    double out_window_sum = state_d[FB_D_OUT_WINDOW_SUM];
    double prev_delta = state_d[FB_D_PREV_DELTA];
    double gain_reduction0 = state_d[FB_D_GAIN_REDUCTION0];
    double gain_reduction1 = state_d[FB_D_GAIN_REDUCTION1];
    unsigned int produced = 0;

    if (just_initialized) {
        opx_write_ffmpeg_state_audit_dev(
            audit_i, audit_d, audit_max_events, audit_sample_windows,
            OPX_FFMPEG_STATE_AUDIT_EVENT_INIT, frame_type, out_frame, total_frames, output_frames,
            input_window, out_frame, write_frame, write_index, short_index, short_count,
            out_short_index, out_short_count, out_window_count, index, above_threshold,
            limiter_state, peak_index, env_index, env_cnt, attack_state, first,
            final_initialized, final_src_offset, limiter_maybe_above_ceiling,
            short_sum, out_short_sum, out_window_sum, prev_delta, gain_reduction0, gain_reduction1, delta, state_d
        );
    }

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
                opx_write_ffmpeg_state_audit_dev(
                    audit_i, audit_d, audit_max_events, audit_sample_windows,
                    OPX_FFMPEG_STATE_AUDIT_EVENT_FINAL_FLUSH_START, frame_type, out_frame, total_frames, output_frames,
                    input_window, out_frame, write_frame, write_index, short_index, short_count,
                    out_short_index, out_short_count, out_window_count, index, above_threshold,
                    limiter_state, peak_index, env_index, env_cnt, attack_state, first,
                    final_initialized, final_src_offset, limiter_maybe_above_ceiling,
                    short_sum, out_short_sum, out_window_sum, prev_delta, gain_reduction0, gain_reduction1, delta, state_d
                );
            }
            unsigned int nb = frames_per_window;
            if (nb > total_frames - out_frame) nb = total_frames - out_frame;
            if (nb > output_frames - produced) nb = output_frames - produced;
            int final_limiter_flag = (state_i[FB_I_PREFILLED_OUTPUT] && state_i[FB_I_PREFILL_CHUNK_SAFE]) ? -1 : limiter_maybe_above_ceiling;
            opx_write_ffmpeg_state_audit_dev(
                audit_i, audit_d, audit_max_events, audit_sample_windows,
                OPX_FFMPEG_STATE_AUDIT_EVENT_LIMITER_BEFORE, frame_type, out_frame, total_frames, output_frames,
                input_window, out_frame, write_frame, write_index, short_index, short_count,
                out_short_index, out_short_count, out_window_count, index, above_threshold,
                limiter_state, peak_index, env_index, env_cnt, attack_state, first,
                final_initialized, final_src_offset, limiter_maybe_above_ceiling,
                short_sum, out_short_sum, out_window_sum, prev_delta, gain_reduction0, gain_reduction1, delta, state_d
            );
            true_peak_limiter_dev(limiter_buf, output, produced, nb, channels, limiter_buf_size, write_index * channels, attack_length, release_length, ceiling, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1, 0, frames_per_window, b, a, 0, 0, 0, 0, 0, 0, 0, output_window_sums, output_metric_state_i, output_metric_state_d, profile_counts, final_limiter_flag, 1, 0, 0, 0, 0, 0);
            if (output_window_sums && !output_metric_state_i) {
                add_feedback_output_dev(output, produced, nb, channels, frames_per_window, b, a, output_window_sums, out_states, out_short_ring, &out_short_sum, &out_short_index, &out_short_count, &out_window_sum, &out_window_count);
            }
            opx_write_ffmpeg_state_audit_dev(
                audit_i, audit_d, audit_max_events, audit_sample_windows,
                OPX_FFMPEG_STATE_AUDIT_EVENT_LIMITER_AFTER, frame_type, out_frame, total_frames, output_frames,
                input_window, out_frame, write_frame, write_index, short_index, short_count,
                out_short_index, out_short_count, out_window_count, index, above_threshold,
                limiter_state, peak_index, env_index, env_cnt, attack_state, first,
                final_initialized, final_src_offset, limiter_maybe_above_ceiling,
                short_sum, out_short_sum, out_window_sum, prev_delta, gain_reduction0, gain_reduction1, delta, state_d
            );
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
        const int device_output_feedback_enabled = !(host_r128_owner_after_threshold && above_threshold != 0 && channels == 6U);
        int feedback_short_count_arg = device_output_feedback_enabled && skip_safe_feedback && normal_limiter_flag < -1 ? -1 : out_short_count;
        opx_write_ffmpeg_state_audit_dev(
            audit_i, audit_d, audit_max_events, audit_sample_windows,
            OPX_FFMPEG_STATE_AUDIT_EVENT_LIMITER_BEFORE, frame_type, out_frame, total_frames, output_frames,
            input_window, out_frame, write_frame, write_index, short_index, short_count,
            out_short_index, out_short_count, out_window_count, index, above_threshold,
            limiter_state, peak_index, env_index, env_cnt, attack_state, first,
            final_initialized, final_src_offset, limiter_maybe_above_ceiling,
            short_sum, out_short_sum, out_window_sum, prev_delta, gain_reduction0, gain_reduction1, delta, state_d
        );
        true_peak_limiter_dev(limiter_buf, output, produced, nb, channels, limiter_buf_size, write_index * channels, attack_length, release_length, ceiling, frame_type, prev_smp, &limiter_state, &peak_index, &env_index, &env_cnt, &attack_state, &gain_reduction0, &gain_reduction1, device_output_feedback_enabled, frames_per_window, b, a, out_states, out_short_ring, &out_short_sum, &out_short_index, &feedback_short_count_arg, &out_window_sum, &out_window_count, output_window_sums, output_metric_state_i, output_metric_state_d, profile_counts, normal_limiter_flag, 1, source_faithful_stereo, source_out_short_ring0, source_out_short_ring1, source_out_window_sum0, source_out_window_sum1);
        opx_write_ffmpeg_state_audit_dev(
            audit_i, audit_d, audit_max_events, audit_sample_windows,
            OPX_FFMPEG_STATE_AUDIT_EVENT_LIMITER_AFTER, frame_type, out_frame, total_frames, output_frames,
            input_window, out_frame, write_frame, write_index, short_index, short_count,
            out_short_index, feedback_short_count_arg, out_window_count, index, above_threshold,
            limiter_state, peak_index, env_index, env_cnt, attack_state, first,
            final_initialized, final_src_offset, limiter_maybe_above_ceiling,
            short_sum, out_short_sum, out_window_sum, prev_delta, gain_reduction0, gain_reduction1, delta, state_d
        );
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
        opx_write_ffmpeg_state_audit_dev(
            audit_i, audit_d, audit_max_events, audit_sample_windows,
            OPX_FFMPEG_STATE_AUDIT_EVENT_DELTA_AFTER, frame_type, out_frame, total_frames, output_frames,
            input_window, out_frame, write_frame, write_index, short_index, short_count,
            out_short_index, out_short_count, out_window_count, index, above_threshold,
            limiter_state, peak_index, env_index, env_cnt, attack_state, first,
            final_initialized, final_src_offset, limiter_maybe_above_ceiling,
            short_sum, out_short_sum, out_window_sum, prev_delta, gain_reduction0, gain_reduction1, delta, state_d
        );
    }

    if (final_initialized && out_frame >= total_frames) {
        opx_write_ffmpeg_state_audit_dev(
            audit_i, audit_d, audit_max_events, audit_sample_windows,
            OPX_FFMPEG_STATE_AUDIT_EVENT_FINAL_FLUSH_END, frame_type, out_frame, total_frames, output_frames,
            input_window, out_frame, write_frame, write_index, short_index, short_count,
            out_short_index, out_short_count, out_window_count, index, above_threshold,
            limiter_state, peak_index, env_index, env_cnt, attack_state, first,
            final_initialized, final_src_offset, limiter_maybe_above_ceiling,
            short_sum, out_short_sum, out_window_sum, prev_delta, gain_reduction0, gain_reduction1, delta, state_d
        );
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
