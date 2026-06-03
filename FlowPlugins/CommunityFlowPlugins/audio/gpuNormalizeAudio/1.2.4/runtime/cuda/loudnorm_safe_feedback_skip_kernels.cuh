extern "C" __global__ void safe_feedback_skip_apply6_f64_kernel(
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
    double *frame_energy,
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
    const double *source_channel_sums,
    unsigned int source_faithful_stereo
) {
    if (blockIdx.x != 0 || (channels != 6U && channels != 2U)) return;
    const unsigned int tid = threadIdx.x;
    const unsigned int stride = blockDim.x;
    const int source_precomputed = (source_faithful_stereo >= 2U && channels == 2U && source_channel_sums);
    const int skip_limiter_lookahead_scan = ((source_faithful_stereo == 3U || source_faithful_stereo == 5U) && source_precomputed);
    const int source_fused_direct_feedback = (source_faithful_stereo >= 4U && source_precomputed);
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
    double *source_out_short_ring0 = state_d + FB_D_SOURCE_OUT_SHORT_RING0;
    double *source_out_short_ring1 = state_d + FB_D_SOURCE_OUT_SHORT_RING1;

    __shared__ unsigned int short_index_s;
    __shared__ unsigned int short_count_s;
    __shared__ unsigned int out_window_count_s;
    __shared__ unsigned int out_frame_s;
    __shared__ unsigned int write_frame_s;
    __shared__ unsigned int write_index_s;
    __shared__ unsigned int input_window_s;
    __shared__ unsigned int produced_s;
    __shared__ unsigned int nb_s;
    __shared__ unsigned int output_limiter_index_s;
    __shared__ unsigned int input_missing_s;
    __shared__ int out_short_index_s;
    __shared__ int out_short_count_s;
    __shared__ int delta_index_s;
    __shared__ int above_threshold_s;
    __shared__ int frame_type_s;
    __shared__ double short_sum_s;
    __shared__ double out_short_sum_s;
    __shared__ double out_window_sum_s;
    __shared__ double prev_delta_s;
    __shared__ double gain_s;
    __shared__ double gain_diff_s;
    __shared__ unsigned int limiter_maybe_above_s;
    __shared__ int use_limiter_s;
    __shared__ int limiter_state_s;
    __shared__ int peak_index_s;
    __shared__ int env_index_s;
    __shared__ int env_cnt_s;
    __shared__ int attack_state_s;
    __shared__ double gain_reduction0_s;
    __shared__ double gain_reduction1_s;
    __shared__ double source_out_window_sum0_s;
    __shared__ double source_out_window_sum1_s;
    __shared__ double source_feedback_sum_s[2];

    if (tid == 0U) {
        short_index_s = state_i[FB_I_SHORT_INDEX];
        short_count_s = state_i[FB_I_SHORT_COUNT];
        out_window_count_s = state_i[FB_I_OUT_WINDOW_COUNT];
        out_frame_s = state_i[FB_I_OUT_FRAME];
        write_frame_s = state_i[FB_I_WRITE_FRAME];
        write_index_s = state_i[FB_I_WRITE_INDEX];
        input_window_s = state_i[FB_I_INPUT_WINDOW];
        produced_s = 0U;
        input_missing_s = 0U;
        out_short_index_s = (int)state_i[FB_I_OUT_SHORT_INDEX];
        out_short_count_s = (int)state_i[FB_I_OUT_SHORT_COUNT];
        delta_index_s = (int)state_i[FB_I_DELTA_INDEX];
        above_threshold_s = (int)state_i[FB_I_ABOVE_THRESHOLD];
        frame_type_s = (int)state_i[FB_I_FRAME_TYPE];
        short_sum_s = state_d[FB_D_SHORT_SUM];
        out_short_sum_s = state_d[FB_D_OUT_SHORT_SUM];
        out_window_sum_s = state_d[FB_D_OUT_WINDOW_SUM];
        prev_delta_s = state_d[FB_D_PREV_DELTA];
        limiter_maybe_above_s = state_i[FB_I_LIMITER_MAYBE_ABOVE_CEILING];
        use_limiter_s = 0;
        limiter_state_s = (int)state_i[FB_I_LIMITER_STATE];
        peak_index_s = (int)state_i[FB_I_PEAK_INDEX];
        env_index_s = (int)state_i[FB_I_ENV_INDEX];
        env_cnt_s = (int)state_i[FB_I_ENV_CNT];
        attack_state_s = (int)state_i[FB_I_ATTACK_STATE];
        gain_reduction0_s = state_d[FB_D_GAIN_REDUCTION0];
        gain_reduction1_s = state_d[FB_D_GAIN_REDUCTION1];
        source_out_window_sum0_s = state_d[FB_D_SOURCE_OUT_WINDOW_SUM0];
        source_out_window_sum1_s = state_d[FB_D_SOURCE_OUT_WINDOW_SUM1];
    }
    __syncthreads();

    double out_v1 = 0.0;
    double out_v2 = 0.0;
    double out_v3 = 0.0;
    double out_v4 = 0.0;
    if (source_precomputed && tid < 2U) {
        const unsigned int state_base = tid * 4U;
        out_v1 = out_states[state_base + 0U];
        out_v2 = out_states[state_base + 1U];
        out_v3 = out_states[state_base + 2U];
        out_v4 = out_states[state_base + 3U];
    }

    while (produced_s < output_frames && out_frame_s < total_frames) {
        if (tid == 0U) {
            unsigned int nb = frames_per_window;
            if (nb > total_frames - out_frame_s) nb = total_frames - out_frame_s;
            if (nb > output_frames - produced_s) nb = output_frames - produced_s;
            nb_s = nb;
            gain_s = gaussian_filter_dev(delta, weights, (delta_index_s + 10) < 30 ? (delta_index_s + 10) : (delta_index_s + 10 - 30));
            double gain_next = gaussian_filter_dev(delta, weights, (delta_index_s + 11) < 30 ? (delta_index_s + 11) : (delta_index_s + 11 - 30));
            gain_diff_s = gain_next - gain_s;
        }
        __syncthreads();

        const unsigned int fill_write_index = write_index_s;
        const unsigned int fill_write_frame = write_frame_s;
        const unsigned int fill_samples = nb_s * channels;
        for (unsigned int idx = tid; idx < fill_samples; idx += stride) {
            const unsigned int n = idx / channels;
            const unsigned int c = idx - (n * channels);
            const unsigned int src_frame = fill_write_frame + n;
            double x = 0.0;
            if (src_frame < total_frames && src_frame >= input_base_frame && src_frame < input_base_frame + input_frames) {
                x = input[((unsigned long long)(src_frame - input_base_frame) * (unsigned long long)channels) + c];
            } else if (src_frame < total_frames) {
                atomicExch(&input_missing_s, 1U);
            }
            const double gain_pos = __ddiv_rn((double)n, (double)nb_s);
            const double timed_gain = __dadd_rn(gain_s, __dmul_rn(gain_pos, gain_diff_s));
            const double v = __dmul_rn(__dmul_rn(x, timed_gain), offset_amp);
            if (v > ceiling || v < -ceiling) atomicMax(&limiter_maybe_above_s, 3U);
            unsigned int dst_frame = fill_write_index + n;
            while (dst_frame >= limiter_lookahead_frames) dst_frame -= limiter_lookahead_frames;
            limiter_buf[((unsigned long long)dst_frame * (unsigned long long)channels) + c] = v;
        }
        __syncthreads();

        if (tid == 0U) {
            write_index_s += nb_s;
            while (write_index_s >= limiter_lookahead_frames) write_index_s -= limiter_lookahead_frames;
            write_frame_s += nb_s;
            if (nb_s < frames_per_window) {
                write_index_s += frames_per_window - nb_s;
                while (write_index_s >= limiter_lookahead_frames) write_index_s -= limiter_lookahead_frames;
            }
            output_limiter_index_s = write_index_s;
        }
        __syncthreads();

        if (!skip_limiter_lookahead_scan) {
            for (unsigned int idx = tid; idx < fill_samples; idx += stride) {
                const unsigned int n = idx / channels;
                const unsigned int c = idx - (n * channels);
                unsigned int src_frame = output_limiter_index_s + attack_length + n;
                while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                const double out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
                if (out > ceiling || out < -ceiling) atomicMax(&limiter_maybe_above_s, 3U);
            }
            __syncthreads();
        }

        if (tid == 0U) {
            use_limiter_s = (limiter_maybe_above_s > 0U || limiter_state_s != 0) ? 1 : 0;
        }
        __syncthreads();

        if (use_limiter_s && tid == 0U) {
            true_peak_limiter_dev(
                limiter_buf, output, produced_s, nb_s, channels,
                limiter_lookahead_frames * channels, output_limiter_index_s * channels,
                attack_length, release_length, ceiling, frame_type_s, prev_smp,
                &limiter_state_s, &peak_index_s, &env_index_s, &env_cnt_s,
                &attack_state_s, &gain_reduction0_s, &gain_reduction1_s,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                (int)limiter_maybe_above_s, 1, 0, 0, 0, 0, 0
            );
        }
        __syncthreads();

        if (!use_limiter_s && tid < channels && nb_s > 0U) {
            unsigned int prev_frame = output_limiter_index_s + attack_length + nb_s - 1U;
            while (prev_frame >= limiter_lookahead_frames) prev_frame -= limiter_lookahead_frames;
            prev_smp[tid] = fabs(limiter_buf[((unsigned long long)prev_frame * (unsigned long long)channels) + tid]);
        }

        const int fused_direct_feedback_s = (!use_limiter_s && source_fused_direct_feedback && above_threshold_s == 0 && nb_s > 0U);

        if (!use_limiter_s) for (unsigned int idx = tid; idx < fill_samples; idx += stride) {
            const unsigned int n = idx / channels;
            const unsigned int c = idx - (n * channels);
            unsigned int src_frame = output_limiter_index_s + n;
            while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
            double out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
            if (out > ceiling) out = ceiling;
            else if (out < -ceiling) out = -ceiling;
            output[((unsigned long long)(produced_s + n) * (unsigned long long)channels) + c] = out;
        }
        __syncthreads();

        if (source_precomputed && above_threshold_s == 0) {
            if (tid < 2U) {
                double local_source_sum = 0.0;
                for (unsigned int n = 0; n < nb_s; n++) {
                    double out;
                    if (fused_direct_feedback_s) {
                        unsigned int src_frame = output_limiter_index_s + n;
                        while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                        out = limiter_buf[((unsigned long long)src_frame * 2ULL) + tid];
                        if (out > ceiling) out = ceiling;
                        else if (out < -ceiling) out = -ceiling;
                    } else {
                        out = output[((unsigned long long)(produced_s + n) * 2ULL) + tid];
                    }
                    const double v0 = kweight_v0_rn_dev(out, a, out_v1, out_v2, out_v3, out_v4);
                    const double y = kweight_y_rn_dev(b, v0, out_v1, out_v2, out_v3, out_v4);
                    local_source_sum += y * y;
                    out_v4 = out_v3;
                    out_v3 = out_v2;
                    out_v2 = out_v1;
                    out_v1 = v0;
                }
                source_feedback_sum_s[tid] = local_source_sum;
            }
            __syncthreads();
            if (tid == 0U) {
                source_out_window_sum0_s += source_feedback_sum_s[0];
                source_out_window_sum1_s += source_feedback_sum_s[1];
                out_window_sum_s = source_out_window_sum0_s + source_out_window_sum1_s;
                out_window_count_s += nb_s;
                if (out_window_count_s == frames_per_window) {
                    if (out_short_count_s < 30) out_short_count_s++;
                    source_out_short_ring0[out_short_index_s] = source_out_window_sum0_s;
                    source_out_short_ring1[out_short_index_s] = source_out_window_sum1_s;
                    out_short_ring[out_short_index_s] = source_out_window_sum0_s + source_out_window_sum1_s;
                    out_short_sum_s = source_stereo_recompute_short_sum_dev(source_out_short_ring0, source_out_short_ring1);
                    out_short_index_s++;
                    if (out_short_index_s >= 30) out_short_index_s = 0;
                    source_out_window_sum0_s = 0.0;
                    source_out_window_sum1_s = 0.0;
                    out_window_sum_s = 0.0;
                    out_window_count_s = 0;
                }
            }
            __syncthreads();
        }

        if (tid == 0U && limiter_maybe_above_s > 0U) limiter_maybe_above_s--;
        __syncthreads();

        if (tid == 0U) {
            out_frame_s += nb_s;
            produced_s += nb_s;
            frame_type_s = 1;

            if (input_window_s < windows) {
                double input_window_sum = window_sums[input_window_s];
                double input_hist4_sum = 0.0;
                double input_short_sum = 0.0;
                if (source_precomputed) {
                    const unsigned long long source_base = (unsigned long long)input_window_s * 3ULL;
                    input_window_sum = source_channel_sums[source_base + 0ULL];
                    input_hist4_sum = input_window_s >= 3U ? source_channel_sums[source_base + 1ULL] : 0.0;
                    input_short_sum = source_channel_sums[source_base + 2ULL];
                }
                if (short_count_s == 30) {
                    short_sum_s -= short_ring[short_index_s];
                } else {
                    short_count_s++;
                }
                short_ring[short_index_s] = input_window_sum;
                short_sum_s += input_window_sum;
                short_index_s++;
                if (short_index_s >= 30) short_index_s = 0;
                if (source_precomputed) short_sum_s = input_short_sum;
                if (input_window_s >= 3) {
                    double e = (source_precomputed ? input_hist4_sum : (window_sums[input_window_s] + window_sums[input_window_s - 1] + window_sums[input_window_s - 2] + window_sums[input_window_s - 3])) / (double)(frames_per_window * 4U);
                    if (e >= hist_boundaries[0]) hist[hist_index_from_boundaries_dev(e, hist_boundaries)]++;
                }
            }
            const double global = gated_loudness_lut_boundaries_dev(hist, hist_energies, hist_boundaries);
            const double shortterm = energy_to_loudness_dev(short_sum_s / (double)(frames_per_window * 30U));
            const double relative_threshold = relative_threshold_lut_dev(hist, hist_energies);
            if (above_threshold_s == 0) {
                double shortterm_out = energy_to_loudness_dev(out_short_sum_s / (double)(frames_per_window * 30U));
                if (shortterm > measured_thresh) prev_delta_s *= 1.0058;
                if (shortterm_out >= target_i) above_threshold_s = 1;
            }
            if (shortterm < relative_threshold || shortterm <= -70.0 || above_threshold_s == 0) {
                delta[delta_index_s] = prev_delta_s;
            } else {
                double diff = isfinite(global) ? (shortterm - global) : 0.0;
                double limit = target_lra / 2.0;
                double env_global = fabs(diff) < limit ? diff : (diff < 0.0 ? -limit : limit);
                double env_shortterm = target_i - shortterm;
                delta[delta_index_s] = db_to_amp_dev(env_global + env_shortterm);
            }
            prev_delta_s = delta[delta_index_s];
            delta_index_s++;
            if (delta_index_s >= 30) delta_index_s = 0;
            input_window_s++;
        }
        __syncthreads();
    }

    if (source_precomputed && tid < 2U) {
        const unsigned int state_base = tid * 4U;
        out_states[state_base + 0U] = out_v1;
        out_states[state_base + 1U] = out_v2;
        out_states[state_base + 2U] = out_v3;
        out_states[state_base + 3U] = out_v4;
    }
    __syncthreads();

    if (tid == 0U) {
        if (input_missing_s) state_i[FB_I_INPUT_MISSING] = 1;
        state_i[FB_I_SHORT_INDEX] = short_index_s;
        state_i[FB_I_OUT_SHORT_INDEX] = (unsigned int)out_short_index_s;
        state_i[FB_I_SHORT_COUNT] = short_count_s;
        state_i[FB_I_OUT_SHORT_COUNT] = (unsigned int)out_short_count_s;
        state_i[FB_I_OUT_WINDOW_COUNT] = out_window_count_s;
        state_i[FB_I_DELTA_INDEX] = (unsigned int)delta_index_s;
        state_i[FB_I_ABOVE_THRESHOLD] = (unsigned int)above_threshold_s;
        state_i[FB_I_OUT_FRAME] = out_frame_s;
        state_i[FB_I_WRITE_FRAME] = write_frame_s;
        state_i[FB_I_WRITE_INDEX] = write_index_s;
        state_i[FB_I_INPUT_WINDOW] = input_window_s;
        state_i[FB_I_FRAME_TYPE] = (unsigned int)frame_type_s;
        state_i[FB_I_LIMITER_STATE] = (unsigned int)limiter_state_s;
        state_i[FB_I_PEAK_INDEX] = (unsigned int)peak_index_s;
        state_i[FB_I_ENV_INDEX] = (unsigned int)env_index_s;
        state_i[FB_I_ENV_CNT] = (unsigned int)env_cnt_s;
        state_i[FB_I_ATTACK_STATE] = (unsigned int)attack_state_s;
        state_i[FB_I_LIMITER_MAYBE_ABOVE_CEILING] = limiter_maybe_above_s;
        state_i[FB_I_SKIP_SAFE_FILL] = 0;
        state_i[FB_I_SKIP_SAFE_FEEDBACK] = 0;
        state_i[FB_I_FORCE_SAFE_IDLE] = 0;
        state_i[FB_I_SAFE_FEEDBACK_WINDOW_ACCUM] = 0;
        state_i[FB_I_SAFE_FEEDBACK_SLOT_ACCUM] = 0;
        state_i[FB_I_PARALLEL_UNSAFE_FEEDBACK] = 0;
        state_d[FB_D_SHORT_SUM] = short_sum_s;
        state_d[FB_D_OUT_SHORT_SUM] = out_short_sum_s;
        state_d[FB_D_OUT_WINDOW_SUM] = out_window_sum_s;
        state_d[FB_D_PREV_DELTA] = prev_delta_s;
        state_d[FB_D_GAIN_REDUCTION0] = gain_reduction0_s;
        state_d[FB_D_GAIN_REDUCTION1] = gain_reduction1_s;
        state_d[FB_D_SOURCE_OUT_WINDOW_SUM0] = source_out_window_sum0_s;
        state_d[FB_D_SOURCE_OUT_WINDOW_SUM1] = source_out_window_sum1_s;
    }
}
