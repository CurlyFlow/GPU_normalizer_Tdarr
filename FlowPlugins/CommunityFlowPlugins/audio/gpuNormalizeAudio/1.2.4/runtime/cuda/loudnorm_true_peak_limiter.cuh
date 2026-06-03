extern "C" __device__ void add_feedback_output_dev(
    const double *output,
    unsigned int output_frame_offset,
    unsigned int nb_samples,
    unsigned int channels,
    unsigned int frames_per_window,
    const double *b,
    const double *a,
    double *out_states,
    double *out_short_ring,
    double *out_short_sum,
    int *out_short_index,
    int *out_short_count,
    double *out_window_sum,
    unsigned int *out_window_count
);

extern "C" __device__ double source_stereo_recompute_short_sum_dev(
    const double *ring0,
    const double *ring1
) {
    double sum0 = 0.0;
    double sum1 = 0.0;
    for (int i = 0; i < 30; i++) sum0 += ring0[i];
    for (int i = 0; i < 30; i++) sum1 += ring1[i];
    return sum0 + sum1;
}

extern "C" __device__ void true_peak_limiter_dev(
    double *limiter_buf,
    double *output,
    unsigned int output_frame_offset,
    unsigned int nb_samples,
    unsigned int channels,
    unsigned int limiter_buf_size,
    unsigned int limiter_buf_index,
    unsigned int attack_length,
    unsigned int release_length,
    double ceiling,
    int frame_type,
    double *prev_smp,
    int *limiter_state,
    int *peak_index,
    int *env_index,
    int *env_cnt,
    int *attack_state,
    double *gain_reduction0,
    double *gain_reduction1,
    int feedback_enabled,
    unsigned int frames_per_window,
    const double *b,
    const double *a,
    double *out_states,
    double *out_short_ring,
    double *out_short_sum,
    int *out_short_index,
    int *out_short_count,
    double *out_window_sum,
    unsigned int *out_window_count,
    double *profile_counts,
    int limiter_maybe_above_ceiling,
    int output_enabled,
    unsigned int source_faithful_stereo,
    double *source_out_short_ring0,
    double *source_out_short_ring1,
    double *source_out_window_sum0,
    double *source_out_window_sum1
) {
    int index = (int)limiter_buf_index;
    int smp_cnt = 0;
    double prev_smp_local[16];
    double *prev_smp_work = prev_smp;
    if (channels <= 16U) {
        for (unsigned int c = 0; c < channels; c++) prev_smp_local[c] = prev_smp[c];
        prev_smp_work = prev_smp_local;
    }
    double out_states_local[20];
    double *out_states_work = out_states;
    if (feedback_enabled) {
        for (int i = 0; i < 20; i++) out_states_local[i] = out_states[i];
        out_states_work = out_states_local;
    }
    int limiter_state_work = *limiter_state;
    int peak_index_work = *peak_index;
    int env_index_work = *env_index;
    int env_cnt_work = *env_cnt;
    int attack_state_work = *attack_state;
    double gain_reduction0_work = *gain_reduction0;
    double gain_reduction1_work = *gain_reduction1;
    if (profile_counts) profile_counts[FB_D_COUNT_OUTPUT_FRAMES] += (double)nb_samples;

    if (frame_type == 0) {
        double max_v = 0.0;
        for (int n = 0; n < (int)attack_length; n++) {
            for (int c = 0; c < (int)channels; c++) {
                double v = fabs(limiter_buf[n * (int)channels + c]);
                if (v > max_v) max_v = v;
            }
        }
        if (max_v > ceiling) {
            gain_reduction1_work = __ddiv_rn(ceiling, max_v);
            limiter_state_work = 2;
            for (int n = 0; n < (int)attack_length; n++) {
                for (int c = 0; c < (int)channels; c++) {
                    limiter_buf[n * (int)channels + c] = __dmul_rn(limiter_buf[n * (int)channels + c], gain_reduction1_work);
                    if (profile_counts) profile_counts[FB_D_COUNT_LIMITER_RW_SCALES] += 1.0;
                }
            }
        }
    }

    const int skip_peak_detection = !LOUDNORM_EXACT_GENERIC_LIMITER && (channels == 6U || channels == 2U) && limiter_state_work == 0 && limiter_maybe_above_ceiling <= 0;
    if (skip_peak_detection) {
        int scan_index = (int)limiter_buf_index + ((int)attack_length * (int)channels);
        while (scan_index >= (int)limiter_buf_size) scan_index -= (int)limiter_buf_size;
        if (nb_samples > 0U) {
            int last_index = scan_index + (((int)nb_samples - 1) * (int)channels);
            while (last_index >= (int)limiter_buf_size) last_index -= (int)limiter_buf_size;
            for (int c = 0; c < (int)channels; c++) {
                prev_smp_work[c] = fabs(limiter_buf[last_index + c]);
            }
        }
    } else do {
        if (limiter_state_work == 0) {
            int peak_delta;
            double peak_value;
            detect_peak_dev(limiter_buf, (int)limiter_buf_size, (int)limiter_buf_index, smp_cnt, (int)nb_samples - smp_cnt, (int)channels, attack_state_work, ceiling, frame_type, prev_smp_work, &peak_delta, &peak_value, &peak_index_work, profile_counts);
            if (peak_delta != -1) {
                env_cnt_work = 0;
                smp_cnt += peak_delta - attack_state_work;
                gain_reduction0_work = 1.0;
                gain_reduction1_work = __ddiv_rn(ceiling, peak_value);
                limiter_state_work = 1;
                env_index_work = peak_index_work - (attack_state_work * (int)channels);
                if (env_index_work < 0) env_index_work += (int)limiter_buf_size;
                env_index_work += (env_cnt_work * (int)channels);
                if (env_index_work > (int)limiter_buf_size) env_index_work -= (int)limiter_buf_size;
            } else {
                smp_cnt = (int)nb_samples;
            }
        } else if (limiter_state_work == 1) {
            for (; env_cnt_work < attack_state_work; env_cnt_work++) {
                for (int c = 0; c < (int)channels; c++) {
                    double env_frac = __ddiv_rn((double)env_cnt_work, (double)(attack_state_work - 1));
                    double env_delta = __dsub_rn(gain_reduction0_work, gain_reduction1_work);
                    double env = __dsub_rn(gain_reduction0_work, __dmul_rn(env_frac, env_delta));
                    limiter_buf[env_index_work + c] = __dmul_rn(limiter_buf[env_index_work + c], env);
                    if (profile_counts) profile_counts[FB_D_COUNT_LIMITER_RW_SCALES] += 1.0;
                }
                env_index_work += (int)channels;
                if (env_index_work >= (int)limiter_buf_size) env_index_work -= (int)limiter_buf_size;
                smp_cnt++;
                if (smp_cnt >= (int)nb_samples) {
                    env_cnt_work++;
                    break;
                }
            }
            if (smp_cnt < (int)nb_samples) {
                env_cnt_work = 0;
                attack_state_work = (int)attack_length;
                limiter_state_work = 2;
            }
        } else if (limiter_state_work == 2) {
            int peak_delta;
            double peak_value;
            detect_peak_dev(limiter_buf, (int)limiter_buf_size, (int)limiter_buf_index, smp_cnt, (int)nb_samples, (int)channels, attack_state_work, ceiling, frame_type, prev_smp_work, &peak_delta, &peak_value, &peak_index_work, profile_counts);
            if (peak_delta == -1) {
                limiter_state_work = 3;
                gain_reduction0_work = gain_reduction1_work;
                gain_reduction1_work = 1.0;
                env_cnt_work = 0;
            } else {
                double gain_reduction = __ddiv_rn(ceiling, peak_value);
                if (gain_reduction < gain_reduction1_work) {
                    limiter_state_work = 1;
                    attack_state_work = peak_delta;
                    if (attack_state_work <= 1) attack_state_work = 2;
                    gain_reduction0_work = gain_reduction1_work;
                    gain_reduction1_work = gain_reduction;
                    env_cnt_work = 0;
                } else {
                    for (env_cnt_work = 0; env_cnt_work < peak_delta; env_cnt_work++) {
                        for (int c = 0; c < (int)channels; c++) {
                            limiter_buf[env_index_work + c] = __dmul_rn(limiter_buf[env_index_work + c], gain_reduction1_work);
                            if (profile_counts) profile_counts[FB_D_COUNT_LIMITER_RW_SCALES] += 1.0;
                        }
                        env_index_work += (int)channels;
                        if (env_index_work >= (int)limiter_buf_size) env_index_work -= (int)limiter_buf_size;
                        smp_cnt++;
                        if (smp_cnt >= (int)nb_samples) {
                            env_cnt_work++;
                            break;
                        }
                    }
                }
            }
        } else {
            for (; env_cnt_work < (int)release_length; env_cnt_work++) {
                for (int c = 0; c < (int)channels; c++) {
                    double env_frac = __ddiv_rn((double)env_cnt_work, (double)(release_length - 1));
                    double env_delta = __dsub_rn(gain_reduction1_work, gain_reduction0_work);
                    double env = __dadd_rn(gain_reduction0_work, __dmul_rn(env_frac, env_delta));
                    limiter_buf[env_index_work + c] = __dmul_rn(limiter_buf[env_index_work + c], env);
                    if (profile_counts) profile_counts[FB_D_COUNT_LIMITER_RW_SCALES] += 1.0;
                }
                env_index_work += (int)channels;
                if (env_index_work >= (int)limiter_buf_size) env_index_work -= (int)limiter_buf_size;
                smp_cnt++;
                if (smp_cnt >= (int)nb_samples) {
                    env_cnt_work++;
                    break;
                }
            }
            if (smp_cnt < (int)nb_samples) {
                env_cnt_work = 0;
                limiter_state_work = 0;
            }
        }
    } while (smp_cnt < (int)nb_samples);

    *limiter_state = limiter_state_work;
    *peak_index = peak_index_work;
    *env_index = env_index_work;
    *env_cnt = env_cnt_work;
    *attack_state = attack_state_work;
    *gain_reduction0 = gain_reduction0_work;
    *gain_reduction1 = gain_reduction1_work;

    if (!output_enabled && !feedback_enabled) {
        if (channels <= 16U) {
            for (unsigned int c = 0; c < channels; c++) prev_smp[c] = prev_smp_local[c];
        }
        return;
    }

    if (limiter_maybe_above_ceiling < 0 && !feedback_enabled && channels == 6U && limiter_state_work == 0) {
        if (channels <= 16U) {
            for (unsigned int c = 0; c < channels; c++) prev_smp[c] = prev_smp_local[c];
        }
        return;
    }

    if (!LOUDNORM_EXACT_GENERIC_LIMITER && feedback_enabled && channels == 6U && limiter_maybe_above_ceiling < -1 && limiter_state_work == 0) {
        if (out_short_count && *out_short_count < 0) return;
        if (profile_counts) profile_counts[FB_D_COUNT_FEEDBACK_IIR] += (double)nb_samples * 5.0;
        add_feedback_output_dev(output, output_frame_offset, nb_samples, channels, frames_per_window, b, a, out_states, out_short_ring, out_short_sum, out_short_index, out_short_count, out_window_sum, out_window_count);
        if (channels <= 16U && nb_samples > 0U) {
            const unsigned long long last = ((unsigned long long)(output_frame_offset + nb_samples - 1U) * channels);
            for (unsigned int c = 0; c < channels; c++) prev_smp[c] = fabs(output[last + c]);
        }
        return;
    }

    if (!LOUDNORM_EXACT_GENERIC_LIMITER && feedback_enabled && channels == 6U && limiter_maybe_above_ceiling < 0 && limiter_state_work == 0) {
        if (profile_counts) profile_counts[FB_D_COUNT_FEEDBACK_IIR] += (double)nb_samples * 5.0;
        add_feedback_output_dev(output, output_frame_offset, nb_samples, channels, frames_per_window, b, a, out_states, out_short_ring, out_short_sum, out_short_index, out_short_count, out_window_sum, out_window_count);
        if (channels <= 16U) {
            for (unsigned int c = 0; c < channels; c++) prev_smp[c] = prev_smp_local[c];
        }
        return;
    }

    if (!LOUDNORM_EXACT_GENERIC_LIMITER && feedback_enabled && channels == 6U) {
        double out_window_sum_work = *out_window_sum;
        unsigned int out_window_count_work = *out_window_count;
        double out_short_sum_work = *out_short_sum;
        int out_short_index_work = *out_short_index;
        int out_short_count_work = *out_short_count;
        const double neg_ceiling = -ceiling;
        double s00 = out_states_work[0];
        double s01 = out_states_work[1];
        double s02 = out_states_work[2];
        double s03 = out_states_work[3];
        double s10 = out_states_work[4];
        double s11 = out_states_work[5];
        double s12 = out_states_work[6];
        double s13 = out_states_work[7];
        double s20 = out_states_work[8];
        double s21 = out_states_work[9];
        double s22 = out_states_work[10];
        double s23 = out_states_work[11];
        double s30 = out_states_work[12];
        double s31 = out_states_work[13];
        double s32 = out_states_work[14];
        double s33 = out_states_work[15];
        double s40 = out_states_work[16];
        double s41 = out_states_work[17];
        double s42 = out_states_work[18];
        double s43 = out_states_work[19];
        if (profile_counts) {
            profile_counts[FB_D_COUNT_OUTPUT_WRITES] += (double)nb_samples * 6.0;
            profile_counts[FB_D_COUNT_FEEDBACK_IIR] += (double)nb_samples * 5.0;
        }
        for (unsigned int n = 0; n < nb_samples; n++) {
            double frame_sum = 0.0;
            const unsigned long long output_index = ((unsigned long long)(output_frame_offset + n) * 6ULL);
            double out = limiter_buf[index + 0];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 0] = out;
            {
                double v1 = s00;
                double v2 = s01;
                double v3 = s02;
                double v4 = s03;
                double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                frame_sum += y * y;
                s03 = v3;
                s02 = v2;
                s01 = v1;
                s00 = v0;
            }

            out = limiter_buf[index + 1];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 1] = out;
            {
                double v1 = s10;
                double v2 = s11;
                double v3 = s12;
                double v4 = s13;
                double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                frame_sum += y * y;
                s13 = v3;
                s12 = v2;
                s11 = v1;
                s10 = v0;
            }

            out = limiter_buf[index + 2];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 2] = out;
            {
                double v1 = s20;
                double v2 = s21;
                double v3 = s22;
                double v4 = s23;
                double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                frame_sum += y * y;
                s23 = v3;
                s22 = v2;
                s21 = v1;
                s20 = v0;
            }

            out = limiter_buf[index + 3];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 3] = out;

            out = limiter_buf[index + 4];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 4] = out;
            {
                double v1 = s30;
                double v2 = s31;
                double v3 = s32;
                double v4 = s33;
                double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                frame_sum += y * y * 1.41;
                s33 = v3;
                s32 = v2;
                s31 = v1;
                s30 = v0;
            }

            out = limiter_buf[index + 5];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 5] = out;
            {
                double v1 = s40;
                double v2 = s41;
                double v3 = s42;
                double v4 = s43;
                double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                frame_sum += y * y * 1.41;
                s43 = v3;
                s42 = v2;
                s41 = v1;
                s40 = v0;
            }

            out_window_sum_work += frame_sum;
            out_window_count_work++;
            if (out_window_count_work == frames_per_window) {
                if (out_short_count_work == 30) {
                    out_short_sum_work -= out_short_ring[out_short_index_work];
                } else {
                    out_short_count_work++;
                }
                out_short_ring[out_short_index_work] = out_window_sum_work;
                if (profile_counts) profile_counts[FB_D_COUNT_SHORT_RING_WRITES] += 1.0;
                out_short_sum_work += out_window_sum_work;
                out_short_index_work++;
                if (out_short_index_work >= 30) out_short_index_work = 0;
                out_window_sum_work = 0.0;
                out_window_count_work = 0;
            }
            index += 6;
            if (index >= (int)limiter_buf_size) index -= (int)limiter_buf_size;
        }
        *out_window_sum = out_window_sum_work;
        *out_window_count = out_window_count_work;
        *out_short_sum = out_short_sum_work;
        *out_short_index = out_short_index_work;
        *out_short_count = out_short_count_work;
        out_states[0] = s00;
        out_states[1] = s01;
        out_states[2] = s02;
        out_states[3] = s03;
        out_states[4] = s10;
        out_states[5] = s11;
        out_states[6] = s12;
        out_states[7] = s13;
        out_states[8] = s20;
        out_states[9] = s21;
        out_states[10] = s22;
        out_states[11] = s23;
        out_states[12] = s30;
        out_states[13] = s31;
        out_states[14] = s32;
        out_states[15] = s33;
        out_states[16] = s40;
        out_states[17] = s41;
        out_states[18] = s42;
        out_states[19] = s43;
        if (channels <= 16U) {
            for (unsigned int c = 0; c < channels; c++) prev_smp[c] = prev_smp_local[c];
        }
        return;
    }

    const double neg_ceiling = -ceiling;
    if (!LOUDNORM_EXACT_GENERIC_LIMITER && !feedback_enabled && channels == 6U) {
        if (profile_counts) profile_counts[FB_D_COUNT_OUTPUT_WRITES] += (double)nb_samples * 6.0;
        for (unsigned int n = 0; n < nb_samples; n++) {
            const unsigned long long output_index = ((unsigned long long)(output_frame_offset + n) * 6ULL);
            double out = limiter_buf[index + 0];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 0] = out;
            out = limiter_buf[index + 1];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 1] = out;
            out = limiter_buf[index + 2];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 2] = out;
            out = limiter_buf[index + 3];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 3] = out;
            out = limiter_buf[index + 4];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 4] = out;
            out = limiter_buf[index + 5];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 5] = out;
            index += 6;
            if (index >= (int)limiter_buf_size) index -= (int)limiter_buf_size;
        }
        if (channels <= 16U) {
            for (unsigned int c = 0; c < channels; c++) prev_smp[c] = prev_smp_local[c];
        }
        return;
    }
    if (!LOUDNORM_EXACT_GENERIC_LIMITER && !feedback_enabled && channels == 2U) {
        if (profile_counts) profile_counts[FB_D_COUNT_OUTPUT_WRITES] += (double)nb_samples * 2.0;
        for (unsigned int n = 0; n < nb_samples; n++) {
            const unsigned long long output_index = ((unsigned long long)(output_frame_offset + n) * 2ULL);
            double out = limiter_buf[index + 0];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 0] = out;
            out = limiter_buf[index + 1];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[output_index + 1] = out;
            index += 2;
            if (index >= (int)limiter_buf_size) index -= (int)limiter_buf_size;
        }
        if (channels <= 16U) {
            for (unsigned int c = 0; c < channels; c++) prev_smp[c] = prev_smp_local[c];
        }
        return;
    }
    const int source_stereo_feedback = source_faithful_stereo && feedback_enabled && channels == 2U && source_out_short_ring0 && source_out_short_ring1 && source_out_window_sum0 && source_out_window_sum1;
    double source_window_sum0 = source_stereo_feedback ? *source_out_window_sum0 : 0.0;
    double source_window_sum1 = source_stereo_feedback ? *source_out_window_sum1 : 0.0;
    if (profile_counts) profile_counts[FB_D_COUNT_OUTPUT_WRITES] += (double)nb_samples * (double)channels;
    for (unsigned int n = 0; n < nb_samples; n++) {
        double frame_sum = 0.0;
        for (unsigned int c = 0; c < channels; c++) {
            double out = limiter_buf[index + (int)c];
            if (out > ceiling) out = ceiling;
            else if (out < neg_ceiling) out = neg_ceiling;
            output[((unsigned long long)(output_frame_offset + n) * channels) + c] = out;
            if (feedback_enabled) {
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
                if (slot >= 0) {
                    if (profile_counts) profile_counts[FB_D_COUNT_FEEDBACK_IIR] += 1.0;
                    const unsigned int base = (unsigned int)slot * 4U;
                    double v1 = out_states_work[base + 0];
                    double v2 = out_states_work[base + 1];
                    double v3 = out_states_work[base + 2];
                    double v4 = out_states_work[base + 3];
                    double v0 = kweight_v0_rn_dev(out, a, v1, v2, v3, v4);
                    double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
                    const double energy = y * y * (slot >= 3 ? 1.41 : 1.0);
                    if (source_stereo_feedback) {
                        if (c == 0U) source_window_sum0 += energy;
                        else if (c == 1U) source_window_sum1 += energy;
                    } else {
                        frame_sum += energy;
                    }
                    out_states_work[base + 3] = v3;
                    out_states_work[base + 2] = v2;
                    out_states_work[base + 1] = v1;
                    out_states_work[base + 0] = v0;
                }
            }
        }
        if (feedback_enabled) {
            if (source_stereo_feedback) {
                *out_window_sum = source_window_sum0 + source_window_sum1;
            } else {
                *out_window_sum += frame_sum;
            }
            (*out_window_count)++;
            if (*out_window_count == frames_per_window) {
                if (source_stereo_feedback) {
                    if (*out_short_count < 30) (*out_short_count)++;
                    source_out_short_ring0[*out_short_index] = source_window_sum0;
                    source_out_short_ring1[*out_short_index] = source_window_sum1;
                    out_short_ring[*out_short_index] = source_window_sum0 + source_window_sum1;
                    if (profile_counts) profile_counts[FB_D_COUNT_SHORT_RING_WRITES] += 1.0;
                    *out_short_sum = source_stereo_recompute_short_sum_dev(source_out_short_ring0, source_out_short_ring1);
                    (*out_short_index)++;
                    if (*out_short_index >= 30) *out_short_index = 0;
                    source_window_sum0 = 0.0;
                    source_window_sum1 = 0.0;
                    *out_window_sum = 0.0;
                    *out_window_count = 0;
                } else {
                    if (*out_short_count == 30) {
                        *out_short_sum -= out_short_ring[*out_short_index];
                    } else {
                        (*out_short_count)++;
                    }
                    out_short_ring[*out_short_index] = *out_window_sum;
                    if (profile_counts) profile_counts[FB_D_COUNT_SHORT_RING_WRITES] += 1.0;
                    *out_short_sum += *out_window_sum;
                    (*out_short_index)++;
                    if (*out_short_index >= 30) *out_short_index = 0;
                    *out_window_sum = 0.0;
                    *out_window_count = 0;
                }
            }
        }
        index += channels;
        if (index >= (int)limiter_buf_size) index -= (int)limiter_buf_size;
    }
    if (feedback_enabled) {
        for (int i = 0; i < 20; i++) out_states[i] = out_states_work[i];
        if (source_stereo_feedback) {
            *source_out_window_sum0 = source_window_sum0;
            *source_out_window_sum1 = source_window_sum1;
        }
    }
    if (channels <= 16U) {
        for (unsigned int c = 0; c < channels; c++) prev_smp[c] = prev_smp_local[c];
    }
}

extern "C" __device__ int ebur_channel_slot_dev(unsigned int channels, unsigned int c) {
    if (channels == 4) {
        if (c == 0) return 0;
        if (c == 1) return 1;
        if (c == 2) return 3;
        if (c == 3) return 4;
        return -1;
    }
    if (channels == 5) {
        if (c == 0) return 0;
        if (c == 1) return 1;
        if (c == 2) return 2;
        if (c == 3) return 3;
        if (c == 4) return 4;
        return -1;
    }
    if (c == 0) return 0;
    if (c == 1) return 1;
    if (c == 2) return 2;
    if (c == 4) return 3;
    if (c == 5) return 4;
    return -1;
}

extern "C" __device__ double ebur_slot_weight_dev(int slot) {
    return slot >= 3 ? 1.41 : 1.0;
}
