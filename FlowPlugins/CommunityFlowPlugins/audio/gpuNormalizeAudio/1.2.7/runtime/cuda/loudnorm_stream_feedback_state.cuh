extern "C" __global__ void kweight_window_sums_f64_stream_kernel(
    const double *input,
    double *sums,
    unsigned int *state_i,
    double *state_d,
    unsigned int frames,
    unsigned int channels,
    unsigned int frames_per_window,
    const double *b,
    const double *a
) {
    if (blockIdx.x != 0 || threadIdx.x != 0) return;
    unsigned int window_index = state_i[0];
    unsigned int window_count = state_i[1];
    double window_sum = state_d[(unsigned long long)channels * 4ULL];
    if (channels <= 16U) {
        double v1s[16];
        double v2s[16];
        double v3s[16];
        double v4s[16];
        for (unsigned int c = 0; c < channels; c++) {
            const unsigned long long base = (unsigned long long)c * 4ULL;
            v1s[c] = state_d[base + 0];
            v2s[c] = state_d[base + 1];
            v3s[c] = state_d[base + 2];
            v4s[c] = state_d[base + 3];
        }
        for (unsigned int n = 0; n < frames; n++) {
            double frame_sum = 0.0;
            for (unsigned int c = 0; c < channels; c++) {
                const int slot = ebur_channel_slot_dev(channels, c);
                if (slot < 0) continue;
                const double x = input[((unsigned long long)n * channels) + c];
                const double v0 = kweight_v0_rn_dev(x, a, v1s[c], v2s[c], v3s[c], v4s[c]);
                const double y = kweight_y_rn_dev(b, v0, v1s[c], v2s[c], v3s[c], v4s[c]);
                frame_sum += y * y * ebur_slot_weight_dev(slot);
                v4s[c] = v3s[c];
                v3s[c] = v2s[c];
                v2s[c] = v1s[c];
                v1s[c] = v0;
            }
            window_sum += frame_sum;
            window_count++;
            if (window_count == frames_per_window) {
                sums[window_index] = window_sum;
                window_index++;
                window_sum = 0.0;
                window_count = 0;
            }
        }
        for (unsigned int c = 0; c < channels; c++) {
            const unsigned long long base = (unsigned long long)c * 4ULL;
            state_d[base + 0] = v1s[c];
            state_d[base + 1] = v2s[c];
            state_d[base + 2] = v3s[c];
            state_d[base + 3] = v4s[c];
        }
        if (window_count > 0) sums[window_index] = window_sum;
        state_i[0] = window_index;
        state_i[1] = window_count;
        state_d[(unsigned long long)channels * 4ULL] = window_sum;
        return;
    }
    for (unsigned int n = 0; n < frames; n++) {
        double frame_sum = 0.0;
        for (unsigned int c = 0; c < channels; c++) {
            const int slot = ebur_channel_slot_dev(channels, c);
            if (slot < 0) continue;
            const unsigned long long base = (unsigned long long)c * 4ULL;
            double v1 = state_d[base + 0];
            double v2 = state_d[base + 1];
            double v3 = state_d[base + 2];
            double v4 = state_d[base + 3];
            const double x = input[((unsigned long long)n * channels) + c];
            const double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
            const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
            frame_sum += y * y * ebur_slot_weight_dev(slot);
            state_d[base + 3] = v3;
            state_d[base + 2] = v2;
            state_d[base + 1] = v1;
            state_d[base + 0] = v0;
        }
        window_sum += frame_sum;
        window_count++;
        if (window_count == frames_per_window) {
            sums[window_index] = window_sum;
            window_index++;
            window_sum = 0.0;
            window_count = 0;
        }
    }
    if (window_count > 0) sums[window_index] = window_sum;
    state_i[0] = window_index;
    state_i[1] = window_count;
    state_d[(unsigned long long)channels * 4ULL] = window_sum;
}

extern "C" __device__ void add_feedback_output_dev(
    const double *output,
    unsigned int output_frame_offset,
    unsigned int nb_samples,
    unsigned int channels,
    unsigned int frames_per_window,
    const double *b,
    const double *a,
    double *output_window_sums,
    double *out_states,
    double *out_short_ring,
    double *out_short_sum,
    int *out_short_index,
    int *out_short_count,
    double *out_window_sum,
    unsigned int *out_window_count
) {
    if (!LOUDNORM_EXACT_GENERIC_LIMITER && channels == 6U) {
        double out_window_sum_work = *out_window_sum;
        unsigned int out_window_count_work = *out_window_count;
        double out_short_sum_work = *out_short_sum;
        int out_short_index_work = *out_short_index;
        int out_short_count_work = *out_short_count;
        double s00 = out_states[0];
        double s01 = out_states[1];
        double s02 = out_states[2];
        double s03 = out_states[3];
        double s10 = out_states[4];
        double s11 = out_states[5];
        double s12 = out_states[6];
        double s13 = out_states[7];
        double s20 = out_states[8];
        double s21 = out_states[9];
        double s22 = out_states[10];
        double s23 = out_states[11];
        double s30 = out_states[12];
        double s31 = out_states[13];
        double s32 = out_states[14];
        double s33 = out_states[15];
        double s40 = out_states[16];
        double s41 = out_states[17];
        double s42 = out_states[18];
        double s43 = out_states[19];
        for (unsigned int n = 0; n < nb_samples; n++) {
            double frame_sum = 0.0;
            const unsigned long long output_index = ((unsigned long long)(output_frame_offset + n) * 6ULL);
            double x = output[output_index + 0];
            double v0 = kweight_v0_rn_dev(x, a, s00, s01, s02, s03);
            double y = kweight_y_rn_dev(b, v0, s00, s01, s02, s03);
            frame_sum += y * y;
            s03 = s02;
            s02 = s01;
            s01 = s00;
            s00 = v0;

            x = output[output_index + 1];
            v0 = kweight_v0_rn_dev(x, a, s10, s11, s12, s13);
            y = kweight_y_rn_dev(b, v0, s10, s11, s12, s13);
            frame_sum += y * y;
            s13 = s12;
            s12 = s11;
            s11 = s10;
            s10 = v0;

            x = output[output_index + 2];
            v0 = kweight_v0_rn_dev(x, a, s20, s21, s22, s23);
            y = kweight_y_rn_dev(b, v0, s20, s21, s22, s23);
            frame_sum += y * y;
            s23 = s22;
            s22 = s21;
            s21 = s20;
            s20 = v0;

            x = output[output_index + 4];
            v0 = kweight_v0_rn_dev(x, a, s30, s31, s32, s33);
            y = kweight_y_rn_dev(b, v0, s30, s31, s32, s33);
            frame_sum += (y * y) * 1.41;
            s33 = s32;
            s32 = s31;
            s31 = s30;
            s30 = v0;

            x = output[output_index + 5];
            v0 = kweight_v0_rn_dev(x, a, s40, s41, s42, s43);
            y = kweight_y_rn_dev(b, v0, s40, s41, s42, s43);
            frame_sum += (y * y) * 1.41;
            s43 = s42;
            s42 = s41;
            s41 = s40;
            s40 = v0;

            out_window_sum_work += frame_sum;
            out_window_count_work++;
            if (out_window_count_work == frames_per_window) {
                if (out_short_count_work == 30) {
                    out_short_sum_work -= out_short_ring[out_short_index_work];
                } else {
                    out_short_count_work++;
                }
                out_short_ring[out_short_index_work] = out_window_sum_work;
                out_short_sum_work += out_window_sum_work;
                out_short_index_work++;
                if (out_short_index_work >= 30) out_short_index_work = 0;
                if (output_window_sums) {
                    output_window_sums[(output_frame_offset + n) / frames_per_window] = out_window_sum_work;
                }
                out_window_sum_work = 0.0;
                out_window_count_work = 0;
            }
        }
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
        *out_short_sum = out_short_sum_work;
        *out_short_index = out_short_index_work;
        *out_short_count = out_short_count_work;
        *out_window_sum = out_window_sum_work;
        *out_window_count = out_window_count_work;
        return;
    }
    for (unsigned int n = 0; n < nb_samples; n++) {
        double frame_sum = 0.0;
        for (unsigned int c = 0; c < channels; c++) {
            int slot = ebur_channel_slot_dev(channels, c);
            if (slot < 0) continue;
            const unsigned int base = (unsigned int)slot * 4U;
            double v1 = out_states[base + 0];
            double v2 = out_states[base + 1];
            double v3 = out_states[base + 2];
            double v4 = out_states[base + 3];
            double x = output[((unsigned long long)(output_frame_offset + n) * channels) + c];
            double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
            double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
            frame_sum += y * y * ebur_slot_weight_dev(slot);
            out_states[base + 3] = v3;
            out_states[base + 2] = v2;
            out_states[base + 1] = v1;
            out_states[base + 0] = v0;
        }
        *out_window_sum += frame_sum;
        (*out_window_count)++;
        if (*out_window_count == frames_per_window) {
            if (*out_short_count == 30) {
                *out_short_sum -= out_short_ring[*out_short_index];
            } else {
                (*out_short_count)++;
            }
            out_short_ring[*out_short_index] = *out_window_sum;
            *out_short_sum += *out_window_sum;
            (*out_short_index)++;
            if (*out_short_index >= 30) *out_short_index = 0;
            if (output_window_sums) {
                output_window_sums[(output_frame_offset + n) / frames_per_window] = *out_window_sum;
            }
            *out_window_sum = 0.0;
            *out_window_count = 0;
        }
    }
}

#define FB_I_INITIALIZED 0
#define FB_I_SHORT_INDEX 1
#define FB_I_OUT_SHORT_INDEX 2
#define FB_I_SHORT_COUNT 3
#define FB_I_OUT_SHORT_COUNT 4
#define FB_I_OUT_WINDOW_COUNT 5
#define FB_I_DELTA_INDEX 6
#define FB_I_ABOVE_THRESHOLD 7
#define FB_I_OUT_FRAME 8
#define FB_I_WRITE_FRAME 9
#define FB_I_WRITE_INDEX 10
#define FB_I_INPUT_WINDOW 11
#define FB_I_FRAME_TYPE 12
#define FB_I_LIMITER_STATE 13
#define FB_I_PEAK_INDEX 14
#define FB_I_ENV_INDEX 15
#define FB_I_ENV_CNT 16
#define FB_I_ATTACK_STATE 17
#define FB_I_FIRST 18
#define FB_I_FINAL_INITIALIZED 19
#define FB_I_FINAL_SRC_OFFSET 20
#define FB_I_INPUT_MISSING 21
#define FB_I_PROFILE_COUNTS 22
#define FB_I_LIMITER_MAYBE_ABOVE_CEILING 23
#define FB_I_PREFILLED_OUTPUT 24
#define FB_I_PREFILL_CHUNK_SAFE 25
#define FB_I_SKIP_SAFE_FILL 26
#define FB_I_SKIP_SAFE_FEEDBACK 27
#define FB_I_FORCE_SAFE_IDLE 28
#define FB_I_SAFE_FEEDBACK_WINDOW_ACCUM 29
#define FB_I_SAFE_FEEDBACK_SLOT_ACCUM 30
#define FB_I_PARALLEL_UNSAFE_FEEDBACK 31

#define SAFE_FEEDBACK_TILE_FRAMES 512U

#define FB_D_SHORT_RING 0
#define FB_D_OUT_SHORT_RING 30
#define FB_D_DELTA 60
#define FB_D_OUT_STATES 90
#define FB_D_SHORT_SUM 110
#define FB_D_OUT_SHORT_SUM 111
#define FB_D_OUT_WINDOW_SUM 112
#define FB_D_PREV_DELTA 113
#define FB_D_GAIN_REDUCTION0 114
#define FB_D_GAIN_REDUCTION1 115
#define FB_D_SOURCE_OUT_SHORT_RING0 128
#define FB_D_SOURCE_OUT_SHORT_RING1 158
#define FB_D_SOURCE_OUT_WINDOW_SUM0 188
#define FB_D_SOURCE_OUT_WINDOW_SUM1 189
#define FB_D_SOURCE_IN_STATE0 190
#define FB_D_SOURCE_IN_STATE1 194
