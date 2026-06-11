extern "C" __global__ void safe_feedback_channel_energy_f64_kernel(
    const double *output,
    double *frame_energy,
    double *state_d,
    unsigned int frames,
    unsigned int channels,
    const double *b,
    const double *a
) {
    const unsigned int c = blockIdx.x;
    if (threadIdx.x != 0 || channels != 6U || c >= channels) return;
    const int slot = ebur_channel_slot_dev(channels, c);
    if (slot < 0) return;
    const double weight = ebur_slot_weight_dev(slot);
    double *out_states = state_d + FB_D_OUT_STATES;
    const unsigned int base = (unsigned int)slot * 4U;
    double v1 = out_states[base + 0];
    double v2 = out_states[base + 1];
    double v3 = out_states[base + 2];
    double v4 = out_states[base + 3];
    for (unsigned int n = 0; n < frames; n++) {
        const double x = output[((unsigned long long)n * 6ULL) + c];
        const double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
        const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
        frame_energy[((unsigned long long)n * 5ULL) + (unsigned int)slot] = y * y * weight;
        v4 = v3;
        v3 = v2;
        v2 = v1;
        v1 = v0;
    }
    out_states[base + 0] = v1;
    out_states[base + 1] = v2;
    out_states[base + 2] = v3;
    out_states[base + 3] = v4;
}

extern "C" __global__ void safe_feedback_window_sums_f64_kernel(
    const double *frame_energy,
    double *window_sums,
    unsigned int frames,
    unsigned int frames_per_window
) {
    const unsigned int local_windows = (frames + frames_per_window - 1U) / frames_per_window;
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int local_w = blockIdx.x * blockDim.x + threadIdx.x; local_w < local_windows; local_w += stride) {
        const unsigned int start = local_w * frames_per_window;
        unsigned int end = start + frames_per_window;
        if (end > frames) end = frames;
        double window_sum = 0.0;
        for (unsigned int n = start; n < end; n++) {
            const unsigned long long base = (unsigned long long)n * 5ULL;
            double frame_sum = 0.0;
            frame_sum += frame_energy[base + 0];
            frame_sum += frame_energy[base + 1];
            frame_sum += frame_energy[base + 2];
            frame_sum += frame_energy[base + 3];
            frame_sum += frame_energy[base + 4];
            window_sum += frame_sum;
        }
        window_sums[local_w] = window_sum;
    }
}

extern "C" __global__ void safe_feedback_output_state_f64_kernel(
    unsigned int *state_i,
    double *state_d,
    const double *feedback_window_sums,
    unsigned int local_windows,
    unsigned int frames_per_window
) {
    if (blockIdx.x != 0 || threadIdx.x != 0 || !feedback_window_sums) return;
    double *out_short_ring = state_d + FB_D_OUT_SHORT_RING;
    unsigned int out_window_count = state_i[FB_I_OUT_WINDOW_COUNT];
    int out_short_index = (int)state_i[FB_I_OUT_SHORT_INDEX];
    int out_short_count = (int)state_i[FB_I_OUT_SHORT_COUNT];
    double out_short_sum = state_d[FB_D_OUT_SHORT_SUM];
    double out_window_sum = state_d[FB_D_OUT_WINDOW_SUM];

    for (unsigned int local_w = 0; local_w < local_windows; local_w++) {
        out_window_sum += feedback_window_sums[local_w];
        out_window_count += frames_per_window;
        if (out_window_count == frames_per_window) {
            if (out_short_count == 30) {
                out_short_sum -= out_short_ring[out_short_index];
            } else {
                out_short_count++;
            }
            out_short_ring[out_short_index] = out_window_sum;
            out_short_sum += out_window_sum;
            out_short_index++;
            if (out_short_index >= 30) out_short_index = 0;
            out_window_sum = 0.0;
            out_window_count = 0;
        }
    }

    state_i[FB_I_OUT_SHORT_INDEX] = (unsigned int)out_short_index;
    state_i[FB_I_OUT_SHORT_COUNT] = (unsigned int)out_short_count;
    state_i[FB_I_OUT_WINDOW_COUNT] = out_window_count;
    state_d[FB_D_OUT_SHORT_SUM] = out_short_sum;
    state_d[FB_D_OUT_WINDOW_SUM] = out_window_sum;
}

extern "C" __global__ void safe_feedback_stitch_f64_kernel(
    unsigned int *state_i,
    double *state_d,
    unsigned int *hist,
    const double *output,
    double *prev_smp,
    const double *input_window_sums,
    const double *feedback_window_sums,
    const double *hist_energies,
    const double *hist_boundaries,
    unsigned int local_windows,
    unsigned int total_frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int windows,
    unsigned int limiter_lookahead_frames,
    double target_i,
    double target_lra,
    double measured_i,
    double measured_thresh,
    double ceiling,
    double *fill_gain_pairs,
    unsigned int fill_gain_lead,
    unsigned int fill_gain_count,
    unsigned int source_faithful_stereo
) {
    if (blockIdx.x != 0 || threadIdx.x != 0 || (channels != 6U && channels != 2U)) return;
    const int source_precomputed = source_faithful_stereo >= 2U && channels == 2U && input_window_sums;
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
    int first = (int)state_i[FB_I_FIRST];
    double short_sum = state_d[FB_D_SHORT_SUM];
    double out_short_sum = state_d[FB_D_OUT_SHORT_SUM];
    double out_window_sum = state_d[FB_D_OUT_WINDOW_SUM];
    double prev_delta = state_d[FB_D_PREV_DELTA];
    unsigned int produced = 0U;
    (void)ceiling;
    (void)measured_i;

    if (fill_gain_pairs) {
        for (unsigned int i = 0; i < fill_gain_lead && i < fill_gain_count; i++) {
            int gain_index = index + (int)i - (int)fill_gain_lead;
            while (gain_index < 0) gain_index += 30;
            while (gain_index >= 30) gain_index -= 30;
            int gain_next_index = gain_index + 1;
            if (gain_next_index >= 30) gain_next_index -= 30;
            fill_gain_pairs[(unsigned long long)i * 2ULL] = gaussian_filter_dev(delta, weights, (gain_index + 10) < 30 ? (gain_index + 10) : (gain_index + 10 - 30));
            fill_gain_pairs[(unsigned long long)i * 2ULL + 1ULL] = gaussian_filter_dev(delta, weights, (gain_next_index + 10) < 30 ? (gain_next_index + 10) : (gain_next_index + 10 - 30));
        }
    }

    for (unsigned int local_w = 0; local_w < local_windows && out_frame < total_frames; local_w++) {
        if (fill_gain_pairs) {
            const unsigned int gain_slot = fill_gain_lead + local_w;
            if (gain_slot < fill_gain_count) {
                fill_gain_pairs[(unsigned long long)gain_slot * 2ULL] = gaussian_filter_dev(delta, weights, (index + 10) < 30 ? (index + 10) : (index + 10 - 30));
                fill_gain_pairs[(unsigned long long)gain_slot * 2ULL + 1ULL] = gaussian_filter_dev(delta, weights, (index + 11) < 30 ? (index + 11) : (index + 11 - 30));
            }
        }
        unsigned int nb = frames_per_window;
        if (nb > total_frames - out_frame) nb = total_frames - out_frame;
        if (!first) {
            write_index += nb;
            while (write_index >= limiter_lookahead_frames) write_index -= limiter_lookahead_frames;
            write_frame += nb;
            if (nb < frames_per_window) {
                write_index += frames_per_window - nb;
                while (write_index >= limiter_lookahead_frames) write_index -= limiter_lookahead_frames;
            }
        }

        if (feedback_window_sums) {
            out_window_sum += feedback_window_sums[local_w];
            out_window_count += nb;
            if (out_window_count == frames_per_window) {
                if (out_short_count == 30) {
                    out_short_sum -= out_short_ring[out_short_index];
                } else {
                    out_short_count++;
                }
                out_short_ring[out_short_index] = out_window_sum;
                out_short_sum += out_window_sum;
                out_short_index++;
                if (out_short_index >= 30) out_short_index = 0;
                out_window_sum = 0.0;
                out_window_count = 0;
            }
        }
        out_frame += nb;
        produced += nb;
        frame_type = 1;
        if (first) {
            first = 0;
            continue;
        }

        if (input_window < windows) {
            double input_window_sum = input_window_sums[input_window];
            double input_hist4_sum = 0.0;
            double input_short_sum = 0.0;
            if (source_precomputed) {
                const unsigned long long source_base = (unsigned long long)input_window * 3ULL;
                input_window_sum = input_window_sums[source_base + 0ULL];
                input_hist4_sum = input_window >= 3U ? input_window_sums[source_base + 1ULL] : 0.0;
                input_short_sum = input_window_sums[source_base + 2ULL];
            }
            if (short_count == 30) {
                short_sum -= short_ring[short_index];
            } else {
                short_count++;
            }
            short_ring[short_index] = input_window_sum;
            short_sum += input_window_sum;
            short_index++;
            if (short_index >= 30) short_index = 0;
            if (source_precomputed) short_sum = input_short_sum;
            if (input_window >= 3) {
                double e = (source_precomputed ? input_hist4_sum : (input_window_sums[input_window] + input_window_sums[input_window - 1] + input_window_sums[input_window - 2] + input_window_sums[input_window - 3])) / (double)(frames_per_window * 4U);
                if (e >= hist_boundaries[0]) hist[hist_index_from_boundaries_dev(e, hist_boundaries)]++;
            }
        }

        const double global = gated_loudness_lut_boundaries_dev(hist, hist_energies, hist_boundaries);
        const double shortterm = energy_to_loudness_dev(short_sum / (double)(frames_per_window * 30U));
        const double relative_threshold = relative_threshold_lut_dev(hist, hist_energies);
        if (above_threshold == 0) {
            double shortterm_out = energy_to_loudness_dev(out_short_sum / (double)(frames_per_window * 30U));
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
    state_i[FB_I_FIRST] = (unsigned int)first;
    state_i[FB_I_LIMITER_MAYBE_ABOVE_CEILING] = 0;
    state_i[FB_I_SKIP_SAFE_FILL] = 0;
    state_i[FB_I_SKIP_SAFE_FEEDBACK] = 0;
    state_i[FB_I_FORCE_SAFE_IDLE] = 0;
    state_d[FB_D_SHORT_SUM] = short_sum;
    state_d[FB_D_OUT_SHORT_SUM] = out_short_sum;
    state_d[FB_D_OUT_WINDOW_SUM] = out_window_sum;
    state_d[FB_D_PREV_DELTA] = prev_delta;
    if (produced > 0U) {
        const unsigned long long last = ((unsigned long long)(produced - 1U) * (unsigned long long)channels);
        for (unsigned int c = 0; c < channels; c++) prev_smp[c] = fabs(output[last + c]);
    }
}

extern "C" __global__ void safe_feedback_fill_prefilled_exact_f64_kernel(
    const double *input,
    double *output,
    double *limiter_buf,
    double *prev_smp,
    const double *fill_gain_pairs,
    unsigned int samples,
    unsigned int output_frames,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int limiter_lookahead_frames,
    unsigned int output_frame_offset,
    unsigned int input_base_frame,
    unsigned int input_frames,
    unsigned int write_frame_start,
    unsigned int fill_gain_lead,
    unsigned int fill_gain_count,
    double offset_amp,
    double ceiling
) {
    const unsigned int idx0 = blockIdx.x * blockDim.x + threadIdx.x;
    const unsigned int stride = blockDim.x * gridDim.x;
    for (unsigned int idx = idx0; idx < samples; idx += stride) {
        const unsigned int local_frame = idx / channels;
        const unsigned int c = idx - local_frame * channels;
        const unsigned int frame = output_frame_offset + local_frame;
        if (frame < write_frame_start) {
            unsigned int src_frame = frame;
            while (src_frame >= limiter_lookahead_frames) src_frame -= limiter_lookahead_frames;
            double out = limiter_buf[((unsigned long long)src_frame * channels) + c];
            if (out > ceiling) out = ceiling;
            else if (out < -ceiling) out = -ceiling;
            if (local_frame < output_frames) {
                output[idx] = out;
                if (prev_smp && local_frame + 1U == output_frames) prev_smp[c] = fabs(out);
            }
            continue;
        }
        const long long rel = (long long)frame - (long long)write_frame_start;
        long long fill_window = rel >= 0
            ? rel / (long long)frames_per_window
            : -(((-rel) + (long long)frames_per_window - 1LL) / (long long)frames_per_window);
        long long fill_start = (long long)write_frame_start + (fill_window * (long long)frames_per_window);
        unsigned int pos = (unsigned int)((long long)frame - fill_start);
        long long gain_slot_signed = fill_window + (long long)fill_gain_lead;
        if (gain_slot_signed < 0) gain_slot_signed = 0;
        if ((unsigned long long)gain_slot_signed >= (unsigned long long)fill_gain_count) gain_slot_signed = (long long)fill_gain_count - 1LL;
        const unsigned int gain_slot = (unsigned int)gain_slot_signed;
        const double gain = fill_gain_pairs[(unsigned long long)gain_slot * 2ULL];
        const double gain_next = fill_gain_pairs[(unsigned long long)gain_slot * 2ULL + 1ULL];
        const double timed_gain = gain + (((double)pos / (double)frames_per_window) * (gain_next - gain));
        double x = 0.0;
        if (frame >= input_base_frame && frame < input_base_frame + input_frames) {
            x = input[((unsigned long long)(frame - input_base_frame) * channels) + c];
        }
        double v = (x * timed_gain) * offset_amp;
        unsigned int dst_frame = frame;
        while (dst_frame >= limiter_lookahead_frames) dst_frame -= limiter_lookahead_frames;
        limiter_buf[((unsigned long long)dst_frame * channels) + c] = v;
        double out = v;
        if (out > ceiling) out = ceiling;
        else if (out < -ceiling) out = -ceiling;
        if (local_frame < output_frames) {
            output[idx] = out;
            if (prev_smp && local_frame + 1U == output_frames) prev_smp[c] = fabs(out);
        }
    }
}
