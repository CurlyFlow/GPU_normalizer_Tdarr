extern "C" __global__ void safe_feedback_apply6_f64_kernel(
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
    double *output_window_sums,
    unsigned int source_faithful_stereo
) {
    const unsigned int c = threadIdx.x;
    if (blockIdx.x != 0 || (channels != 6U && channels != 2U) || c >= channels) return;
    const int source_precomputed = (source_faithful_stereo >= 2U && channels == 2U && source_channel_sums);
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
    const int slot = ebur_channel_slot_dev(channels, c);
    const double weight = slot >= 0 ? ebur_slot_weight_dev(slot) : 0.0;
    const unsigned int state_base = slot >= 0 ? (unsigned int)slot * 4U : 0U;
    double v1 = slot >= 0 ? out_states[state_base + 0] : 0.0;
    double v2 = slot >= 0 ? out_states[state_base + 1] : 0.0;
    double v3 = slot >= 0 ? out_states[state_base + 2] : 0.0;
    double v4 = slot >= 0 ? out_states[state_base + 3] : 0.0;

    __shared__ unsigned int short_index_s;
    __shared__ unsigned int short_count_s;
    __shared__ unsigned int out_window_count_s;
    __shared__ unsigned int out_frame_s;
    __shared__ unsigned int write_frame_s;
    __shared__ unsigned int write_index_s;
    __shared__ unsigned int input_window_s;
    __shared__ unsigned int produced_s;
    __shared__ unsigned int nb_s;
    __shared__ int out_short_index_s;
    __shared__ int out_short_count_s;
    __shared__ int delta_index_s;
    __shared__ int above_threshold_s;
    __shared__ int frame_type_s;
    __shared__ int first_s;
    __shared__ int skip_prefilled_s;
    __shared__ int skip_feedback_s;
    __shared__ double short_sum_s;
    __shared__ double out_short_sum_s;
    __shared__ double out_window_sum_s;
    __shared__ double prev_delta_s;
    __shared__ double gain_s;
    __shared__ double gain_diff_s;
    __shared__ unsigned int output_limiter_index_s;
    __shared__ int window_accum_s;
    __shared__ int slot_accum_s;
    __shared__ int parallel_unsafe_s;
    __shared__ int parallel_unsafe_direct_s;
    __shared__ int limiter_maybe_above_s;
    __shared__ int limiter_state_s;
    __shared__ int peak_index_s;
    __shared__ int env_index_s;
    __shared__ int env_cnt_s;
    __shared__ int attack_state_s;
    __shared__ double window_sum_s;
    __shared__ double slot_sum_s[5];
    __shared__ double tile_energy_s[SAFE_FEEDBACK_TILE_FRAMES * 5U];
    __shared__ double gain_reduction0_s;
    __shared__ double gain_reduction1_s;

    if (c == 0U) {
        short_index_s = state_i[FB_I_SHORT_INDEX];
        short_count_s = state_i[FB_I_SHORT_COUNT];
        out_window_count_s = state_i[FB_I_OUT_WINDOW_COUNT];
        out_frame_s = state_i[FB_I_OUT_FRAME];
        write_frame_s = state_i[FB_I_WRITE_FRAME];
        write_index_s = state_i[FB_I_WRITE_INDEX];
        input_window_s = state_i[FB_I_INPUT_WINDOW];
        produced_s = 0U;
        out_short_index_s = (int)state_i[FB_I_OUT_SHORT_INDEX];
        out_short_count_s = (int)state_i[FB_I_OUT_SHORT_COUNT];
        delta_index_s = (int)state_i[FB_I_DELTA_INDEX];
        above_threshold_s = (int)state_i[FB_I_ABOVE_THRESHOLD];
        frame_type_s = (int)state_i[FB_I_FRAME_TYPE];
        first_s = (int)state_i[FB_I_FIRST];
        short_sum_s = state_d[FB_D_SHORT_SUM];
        out_short_sum_s = state_d[FB_D_OUT_SHORT_SUM];
        out_window_sum_s = state_d[FB_D_OUT_WINDOW_SUM];
        prev_delta_s = state_d[FB_D_PREV_DELTA];
        window_accum_s = state_i[FB_I_SAFE_FEEDBACK_WINDOW_ACCUM] ? 1 : 0;
        slot_accum_s = state_i[FB_I_SAFE_FEEDBACK_SLOT_ACCUM] ? 1 : 0;
        parallel_unsafe_s = state_i[FB_I_PARALLEL_UNSAFE_FEEDBACK] ? 1 : 0;
        limiter_maybe_above_s = (int)state_i[FB_I_LIMITER_MAYBE_ABOVE_CEILING];
        limiter_state_s = (int)state_i[FB_I_LIMITER_STATE];
        peak_index_s = (int)state_i[FB_I_PEAK_INDEX];
        env_index_s = (int)state_i[FB_I_ENV_INDEX];
        env_cnt_s = (int)state_i[FB_I_ENV_CNT];
        attack_state_s = (int)state_i[FB_I_ATTACK_STATE];
        gain_reduction0_s = state_d[FB_D_GAIN_REDUCTION0];
        gain_reduction1_s = state_d[FB_D_GAIN_REDUCTION1];
        if (parallel_unsafe_s && limiter_maybe_above_s > 0) limiter_maybe_above_s--;
    }
    __syncthreads();

    while (produced_s < output_frames && out_frame_s < total_frames) {
        if (c == 0U) {
            unsigned int nb = frames_per_window;
            if (nb > total_frames - out_frame_s) nb = total_frames - out_frame_s;
            if (nb > output_frames - produced_s) nb = output_frames - produced_s;
            nb_s = nb;
            skip_prefilled_s = (!parallel_unsafe_s && !first_s && state_i[FB_I_SKIP_SAFE_FILL] && state_i[FB_I_PREFILLED_OUTPUT] && state_i[FB_I_PREFILL_CHUNK_SAFE] && above_threshold_s != 0) ? 1 : 0;
            skip_feedback_s = (!output_window_sums && !first_s && state_i[FB_I_SKIP_SAFE_FEEDBACK] && above_threshold_s != 0) ? 1 : 0;
            if (!first_s && !skip_prefilled_s) {
                gain_s = gaussian_filter_dev(delta, weights, (delta_index_s + 10) < 30 ? (delta_index_s + 10) : (delta_index_s + 10 - 30));
                double gain_next = gaussian_filter_dev(delta, weights, (delta_index_s + 11) < 30 ? (delta_index_s + 11) : (delta_index_s + 11 - 30));
                gain_diff_s = gain_next - gain_s;
            } else {
                gain_s = 0.0;
                gain_diff_s = 0.0;
            }
        }
        __syncthreads();

        const unsigned int fill_write_index = write_index_s;
        const unsigned int fill_write_frame = write_frame_s;
        if (!first_s && !skip_prefilled_s) {
            for (unsigned int n = 0; n < nb_s; n++) {
                const unsigned int src_frame = fill_write_frame + n;
                double x = 0.0;
                if (src_frame < total_frames && src_frame >= input_base_frame && src_frame < input_base_frame + input_frames) {
                    x = input[((unsigned long long)(src_frame - input_base_frame) * (unsigned long long)channels) + c];
                } else if (src_frame < total_frames) {
                    state_i[FB_I_INPUT_MISSING] = 1;
                }
                const double timed_gain = gain_s + (((double)n / (double)nb_s) * gain_diff_s);
                const double v = (x * timed_gain) * offset_amp;
                if (v > ceiling || v < -ceiling) atomicMax((unsigned int *)&limiter_maybe_above_s, 3U);
                unsigned int dst_frame = fill_write_index + n;
                while (dst_frame >= limiter_lookahead_frames) dst_frame -= limiter_lookahead_frames;
                limiter_buf[((unsigned long long)dst_frame * (unsigned long long)channels) + c] = v;
            }
        }
        __syncthreads();

        if (c == 0U) {
            if (!first_s) {
                write_index_s += nb_s;
                while (write_index_s >= limiter_lookahead_frames) write_index_s -= limiter_lookahead_frames;
                write_frame_s += nb_s;
                if (nb_s < frames_per_window) {
                    write_index_s += frames_per_window - nb_s;
                    while (write_index_s >= limiter_lookahead_frames) write_index_s -= limiter_lookahead_frames;
                }
            }
            output_limiter_index_s = write_index_s;
        }
        __syncthreads();

        if (c == 0U) {
            parallel_unsafe_direct_s = (parallel_unsafe_s && limiter_maybe_above_s <= 0 && limiter_state_s == 0) ? 1 : 0;
        }
        __syncthreads();

        if (parallel_unsafe_direct_s && nb_s > 0U) {
            unsigned int prev_frame = output_limiter_index_s + attack_length + nb_s - 1U;
            while (prev_frame >= limiter_lookahead_frames) prev_frame -= limiter_lookahead_frames;
            prev_smp[c] = fabs(limiter_buf[((unsigned long long)prev_frame * (unsigned long long)channels) + c]);
        }
        __syncthreads();

        if (parallel_unsafe_s && !parallel_unsafe_direct_s && c == 0U) {
            true_peak_limiter_dev(
                limiter_buf, output, produced_s, nb_s, channels,
                limiter_lookahead_frames * channels, output_limiter_index_s * channels,
                attack_length, release_length, ceiling, frame_type_s, prev_smp,
                &limiter_state_s, &peak_index_s, &env_index_s, &env_cnt_s,
                &attack_state_s, &gain_reduction0_s, &gain_reduction1_s,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                limiter_maybe_above_s, skip_feedback_s ? 0 : 1, 0, 0, 0, 0, 0
            );
        }
        __syncthreads();

        if (skip_prefilled_s && !parallel_unsafe_s && nb_s > 0U) {
            prev_smp[c] = fabs(output[((unsigned long long)(produced_s + nb_s - 1U) * (unsigned long long)channels) + c]);
        } else if (!skip_prefilled_s && !parallel_unsafe_s) {
            unsigned int prev_frame = output_limiter_index_s + attack_length + nb_s - 1U;
            while (prev_frame >= limiter_lookahead_frames) prev_frame -= limiter_lookahead_frames;
            prev_smp[c] = fabs(limiter_buf[((unsigned long long)prev_frame * (unsigned long long)channels) + c]);
        }

        if (skip_feedback_s) {
            if (c == 0U) window_sum_s = 0.0;
            __syncthreads();
            if (!skip_prefilled_s) {
                for (unsigned int n = 0; n < nb_s; n++) {
                    unsigned int src_frame = output_limiter_index_s + n;
                    while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                    double out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
                    if (out > ceiling) out = ceiling;
                    else if (out < -ceiling) out = -ceiling;
                    output[((unsigned long long)(produced_s + n) * (unsigned long long)channels) + c] = out;
                }
            }
            __syncthreads();
        } else if (slot_accum_s) {
            if (c == 0U) {
                for (unsigned int s = 0; s < 5U; s++) slot_sum_s[s] = 0.0;
            }
            __syncthreads();
            double local_slot_sum = 0.0;
            for (unsigned int n = 0; n < nb_s; n++) {
                double out;
                if (parallel_unsafe_direct_s) {
                    unsigned int src_frame = output_limiter_index_s + n;
                    while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                    out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
                    if (out > ceiling) out = ceiling;
                    else if (out < -ceiling) out = -ceiling;
                    output[((unsigned long long)(produced_s + n) * (unsigned long long)channels) + c] = out;
                } else if (parallel_unsafe_s || skip_prefilled_s) {
                    out = output[((unsigned long long)(produced_s + n) * (unsigned long long)channels) + c];
                } else {
                    unsigned int src_frame = output_limiter_index_s + n;
                    while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                    out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
                    if (out > ceiling) out = ceiling;
                    else if (out < -ceiling) out = -ceiling;
                    output[((unsigned long long)(produced_s + n) * (unsigned long long)channels) + c] = out;
                }
                if (slot >= 0) {
                    const double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                    const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                    local_slot_sum += y * y * weight;
                    v4 = v3;
                    v3 = v2;
                    v2 = v1;
                    v1 = v0;
                }
            }
            if (slot >= 0) slot_sum_s[(unsigned int)slot] = local_slot_sum;
            __syncthreads();
            if (c == 0U) {
                double window_sum = 0.0;
                window_sum += slot_sum_s[0];
                window_sum += slot_sum_s[1];
                window_sum += slot_sum_s[2];
                window_sum += slot_sum_s[3];
                window_sum += slot_sum_s[4];
                window_sum_s = window_sum;
            }
            __syncthreads();
        } else if (window_accum_s) {
            if (c == 0U) window_sum_s = 0.0;
            __syncthreads();
            for (unsigned int tile_start = 0; tile_start < nb_s; tile_start += SAFE_FEEDBACK_TILE_FRAMES) {
                unsigned int tile_frames = nb_s - tile_start;
                if (tile_frames > SAFE_FEEDBACK_TILE_FRAMES) tile_frames = SAFE_FEEDBACK_TILE_FRAMES;
                if (c == 0U) {
                    for (unsigned int n = 0; n < tile_frames; n++) {
                        const unsigned int base = n * 5U;
                        for (unsigned int s = 0; s < 5U; s++) tile_energy_s[base + s] = 0.0;
                    }
                }
                __syncthreads();
                for (unsigned int n = 0; n < tile_frames; n++) {
                    const unsigned int local_n = tile_start + n;
                    double out;
                    if (parallel_unsafe_direct_s) {
                        unsigned int src_frame = output_limiter_index_s + local_n;
                        while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                        out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
                        if (out > ceiling) out = ceiling;
                        else if (out < -ceiling) out = -ceiling;
                        output[((unsigned long long)(produced_s + local_n) * (unsigned long long)channels) + c] = out;
                    } else if (parallel_unsafe_s || skip_prefilled_s) {
                        out = output[((unsigned long long)(produced_s + local_n) * (unsigned long long)channels) + c];
                    } else {
                        unsigned int src_frame = output_limiter_index_s + local_n;
                        while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                        out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
                        if (out > ceiling) out = ceiling;
                        else if (out < -ceiling) out = -ceiling;
                        output[((unsigned long long)(produced_s + local_n) * (unsigned long long)channels) + c] = out;
                    }
                    if (slot >= 0) {
                        const double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                        const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                        tile_energy_s[((unsigned int)n * 5U) + (unsigned int)slot] = y * y * weight;
                        v4 = v3;
                        v3 = v2;
                        v2 = v1;
                        v1 = v0;
                    }
                }
                __syncthreads();
                if (c == 0U) {
                    for (unsigned int n = 0; n < tile_frames; n++) {
                        const unsigned int base = n * 5U;
                        double frame_sum = 0.0;
                        frame_sum += tile_energy_s[base + 0];
                        frame_sum += tile_energy_s[base + 1];
                        frame_sum += tile_energy_s[base + 2];
                        frame_sum += tile_energy_s[base + 3];
                        frame_sum += tile_energy_s[base + 4];
                        window_sum_s += frame_sum;
                    }
                }
                __syncthreads();
            }
        } else {
            if (c == 0U) {
                for (unsigned int n = 0; n < nb_s; n++) {
                    const unsigned long long base = (unsigned long long)(produced_s + n) * 5ULL;
                    for (unsigned int s = 0; s < 5U; s++) frame_energy[base + s] = 0.0;
                }
            }
            __syncthreads();
            for (unsigned int n = 0; n < nb_s; n++) {
                double out;
                if (parallel_unsafe_direct_s) {
                    unsigned int src_frame = output_limiter_index_s + n;
                    while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                    out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
                    if (out > ceiling) out = ceiling;
                    else if (out < -ceiling) out = -ceiling;
                    output[((unsigned long long)(produced_s + n) * (unsigned long long)channels) + c] = out;
                } else if (parallel_unsafe_s || skip_prefilled_s) {
                    out = output[((unsigned long long)(produced_s + n) * (unsigned long long)channels) + c];
                } else {
                    unsigned int src_frame = output_limiter_index_s + n;
                    while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
                    out = limiter_buf[((unsigned long long)src_frame * (unsigned long long)channels) + c];
                    if (out > ceiling) out = ceiling;
                    else if (out < -ceiling) out = -ceiling;
                    output[((unsigned long long)(produced_s + n) * (unsigned long long)channels) + c] = out;
                }
                if (slot >= 0) {
                    const double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                    const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                    frame_energy[((unsigned long long)(produced_s + n) * 5ULL) + (unsigned int)slot] = y * y * weight;
                    v4 = v3;
                    v3 = v2;
                    v2 = v1;
                    v1 = v0;
                }
            }
            __syncthreads();

            if (c == 0U) {
                double window_sum = 0.0;
                for (unsigned int n = 0; n < nb_s; n++) {
                    const unsigned long long base = (unsigned long long)(produced_s + n) * 5ULL;
                    double frame_sum = 0.0;
                    frame_sum += frame_energy[base + 0];
                    frame_sum += frame_energy[base + 1];
                    frame_sum += frame_energy[base + 2];
                    frame_sum += frame_energy[base + 3];
                    frame_sum += frame_energy[base + 4];
                    window_sum += frame_sum;
                }
                window_sum_s = window_sum;
            }
            __syncthreads();
        }

        if (c == 0U) {
            const double window_sum = window_sum_s;
            if (!skip_feedback_s) {
                out_window_sum_s += window_sum;
                out_window_count_s += nb_s;
                if (out_window_count_s == frames_per_window) {
                    if (out_short_count_s == 30) {
                        out_short_sum_s -= out_short_ring[out_short_index_s];
                    } else {
                        out_short_count_s++;
                    }
                    out_short_ring[out_short_index_s] = out_window_sum_s;
                    out_short_sum_s += out_window_sum_s;
                    out_short_index_s++;
                    if (out_short_index_s >= 30) out_short_index_s = 0;
                    if (output_window_sums) {
                        output_window_sums[(out_frame_s + nb_s - 1U) / frames_per_window] = out_window_sum_s;
                    }
                    out_window_sum_s = 0.0;
                    out_window_count_s = 0;
                }
            }
            out_frame_s += nb_s;
            produced_s += nb_s;
            frame_type_s = 1;
            if (first_s) {
                first_s = 0;
            } else {
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
        }
        __syncthreads();
    }

    if (slot >= 0) {
        out_states[state_base + 0] = v1;
        out_states[state_base + 1] = v2;
        out_states[state_base + 2] = v3;
        out_states[state_base + 3] = v4;
    }
    __syncthreads();
    if (c == 0U) {
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
        state_i[FB_I_FIRST] = (unsigned int)first_s;
        state_i[FB_I_LIMITER_STATE] = (unsigned int)limiter_state_s;
        state_i[FB_I_PEAK_INDEX] = (unsigned int)peak_index_s;
        state_i[FB_I_ENV_INDEX] = (unsigned int)env_index_s;
        state_i[FB_I_ENV_CNT] = (unsigned int)env_cnt_s;
        state_i[FB_I_ATTACK_STATE] = (unsigned int)attack_state_s;
        state_i[FB_I_LIMITER_MAYBE_ABOVE_CEILING] = parallel_unsafe_s ? (unsigned int)limiter_maybe_above_s : 0;
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
    }
}
