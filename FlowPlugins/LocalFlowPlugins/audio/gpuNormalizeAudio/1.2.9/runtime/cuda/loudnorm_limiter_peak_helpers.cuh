extern "C" __device__ unsigned int wrap_sample_index_dev(int index, unsigned int size) {
    while (index < 0) index += (int)size;
    while ((unsigned int)index >= size) index -= (int)size;
    return (unsigned int)index;
}

#define FB_D_COUNT_OUTPUT_FRAMES 116
#define FB_D_COUNT_INPUT_READS 117
#define FB_D_COUNT_INPUT_ZEROS 118
#define FB_D_COUNT_LIMITER_WRITES 119
#define FB_D_COUNT_LIMITER_RW_SCALES 120
#define FB_D_COUNT_OUTPUT_WRITES 121
#define FB_D_COUNT_FEEDBACK_IIR 122
#define FB_D_COUNT_SHORT_RING_WRITES 123
#define FB_D_COUNT_DETECT_CALLS 124
#define FB_D_COUNT_DETECT_FRAMES 125
#define FB_D_COUNT_DETECT_LOOKAHEAD 126
#define FB_D_COUNT_PEAK_HITS 127

extern "C" __device__ void detect_peak_6_dev(
    double *buf,
    int limiter_buf_size,
    int limiter_buf_index,
    int offset,
    int nb_samples,
    int attack_length,
    double ceiling,
    int frame_type,
    double *prev_smp,
    int *peak_delta,
    double *peak_value,
    int *peak_index,
    double *profile_counts
) {
    *peak_delta = -1;
    if (profile_counts) profile_counts[FB_D_COUNT_DETECT_CALLS] += 1.0;
    int index = limiter_buf_index + (offset * 6) + (attack_length * 6);
    if (index >= limiter_buf_size) index -= limiter_buf_size;

    if (frame_type == 0) {
        prev_smp[0] = fabs(buf[index - 6]);
        prev_smp[1] = fabs(buf[index - 5]);
        prev_smp[2] = fabs(buf[index - 4]);
        prev_smp[3] = fabs(buf[index - 3]);
        prev_smp[4] = fabs(buf[index - 2]);
        prev_smp[5] = fabs(buf[index - 1]);
    }

#define DETECT_PEAK6_CHECK(C, THIS_S, NEXT_S) \
    do { \
        int skip_update = 0; \
        if ((prev_smp[C] <= (THIS_S)) && ((NEXT_S) <= (THIS_S)) && ((THIS_S) > ceiling) && (n > 0)) { \
            int detected = 1; \
            for (int i = 2; i < 12; i++) { \
                if (profile_counts) profile_counts[FB_D_COUNT_DETECT_LOOKAHEAD] += 1.0; \
                int lookahead_index = index + C + (i * 6); \
                if (lookahead_index >= limiter_buf_size) lookahead_index -= limiter_buf_size; \
                double next = fabs(buf[lookahead_index]); \
                if (next > (THIS_S)) { \
                    detected = 0; \
                    break; \
                } \
            } \
            if (!detected) { \
                skip_update = 1; \
            } else { \
                double max_peak = t0; \
                if (t1 > max_peak) max_peak = t1; \
                if (t2 > max_peak) max_peak = t2; \
                if (t3 > max_peak) max_peak = t3; \
                if (t4 > max_peak) max_peak = t4; \
                if (t5 > max_peak) max_peak = t5; \
                prev_smp[0] = t0; \
                prev_smp[1] = t1; \
                prev_smp[2] = t2; \
                prev_smp[3] = t3; \
                prev_smp[4] = t4; \
                prev_smp[5] = t5; \
                *peak_delta = n; \
                *peak_index = index; \
                *peak_value = max_peak; \
                if (profile_counts) profile_counts[FB_D_COUNT_PEAK_HITS] += 1.0; \
                return; \
            } \
        } \
        if (!skip_update) prev_smp[C] = (THIS_S); \
    } while (0)

    for (int n = 0; n < nb_samples; n++) {
        if (profile_counts) profile_counts[FB_D_COUNT_DETECT_FRAMES] += 1.0;
        const double t0 = fabs(buf[index + 0]);
        const double t1 = fabs(buf[index + 1]);
        const double t2 = fabs(buf[index + 2]);
        const double t3 = fabs(buf[index + 3]);
        const double t4 = fabs(buf[index + 4]);
        const double t5 = fabs(buf[index + 5]);
        double frame_peak = t0;
        if (t1 > frame_peak) frame_peak = t1;
        if (t2 > frame_peak) frame_peak = t2;
        if (t3 > frame_peak) frame_peak = t3;
        if (t4 > frame_peak) frame_peak = t4;
        if (t5 > frame_peak) frame_peak = t5;
        if (n == 0 || frame_peak <= ceiling) {
            prev_smp[0] = t0;
            prev_smp[1] = t1;
            prev_smp[2] = t2;
            prev_smp[3] = t3;
            prev_smp[4] = t4;
            prev_smp[5] = t5;
            index += 6;
            if (index >= limiter_buf_size) index -= limiter_buf_size;
            continue;
        }
        int next_index = index + 6;
        if (next_index >= limiter_buf_size) next_index -= limiter_buf_size;
        const double n0 = fabs(buf[next_index + 0]);
        const double n1 = fabs(buf[next_index + 1]);
        const double n2 = fabs(buf[next_index + 2]);
        const double n3 = fabs(buf[next_index + 3]);
        const double n4 = fabs(buf[next_index + 4]);
        const double n5 = fabs(buf[next_index + 5]);

        DETECT_PEAK6_CHECK(0, t0, n0);
        DETECT_PEAK6_CHECK(1, t1, n1);
        DETECT_PEAK6_CHECK(2, t2, n2);
        DETECT_PEAK6_CHECK(3, t3, n3);
        DETECT_PEAK6_CHECK(4, t4, n4);
        DETECT_PEAK6_CHECK(5, t5, n5);

        index += 6;
        if (index >= limiter_buf_size) index -= limiter_buf_size;
    }

#undef DETECT_PEAK6_CHECK
}

extern "C" __device__ void detect_peak_2_dev(
    double *buf,
    int limiter_buf_size,
    int limiter_buf_index,
    int offset,
    int nb_samples,
    int attack_length,
    double ceiling,
    int frame_type,
    double *prev_smp,
    int *peak_delta,
    double *peak_value,
    int *peak_index,
    double *profile_counts
) {
    *peak_delta = -1;
    if (profile_counts) profile_counts[FB_D_COUNT_DETECT_CALLS] += 1.0;
    int index = limiter_buf_index + (offset * 2) + (attack_length * 2);
    if (index >= limiter_buf_size) index -= limiter_buf_size;

    if (frame_type == 0) {
        prev_smp[0] = fabs(buf[index - 2]);
        prev_smp[1] = fabs(buf[index - 1]);
    }

#define DETECT_PEAK2_CHECK(C, THIS_S, NEXT_S) \
    do { \
        int skip_update = 0; \
        if ((prev_smp[C] <= (THIS_S)) && ((NEXT_S) <= (THIS_S)) && ((THIS_S) > ceiling) && (n > 0)) { \
            int detected = 1; \
            for (int i = 2; i < 12; i++) { \
                if (profile_counts) profile_counts[FB_D_COUNT_DETECT_LOOKAHEAD] += 1.0; \
                int lookahead_index = index + C + (i * 2); \
                if (lookahead_index >= limiter_buf_size) lookahead_index -= limiter_buf_size; \
                double next = fabs(buf[lookahead_index]); \
                if (next > (THIS_S)) { \
                    detected = 0; \
                    break; \
                } \
            } \
            if (!detected) { \
                skip_update = 1; \
            } else { \
                double max_peak = t0; \
                if (t1 > max_peak) max_peak = t1; \
                prev_smp[0] = t0; \
                prev_smp[1] = t1; \
                *peak_delta = n; \
                *peak_index = index; \
                *peak_value = max_peak; \
                if (profile_counts) profile_counts[FB_D_COUNT_PEAK_HITS] += 1.0; \
                return; \
            } \
        } \
        if (!skip_update) prev_smp[C] = (THIS_S); \
    } while (0)

    for (int n = 0; n < nb_samples; n++) {
        if (profile_counts) profile_counts[FB_D_COUNT_DETECT_FRAMES] += 1.0;
        const double t0 = fabs(buf[index + 0]);
        const double t1 = fabs(buf[index + 1]);
        const double frame_peak = t0 > t1 ? t0 : t1;
        if (n == 0 || frame_peak <= ceiling) {
            prev_smp[0] = t0;
            prev_smp[1] = t1;
            index += 2;
            if (index >= limiter_buf_size) index -= limiter_buf_size;
            continue;
        }
        int next_index = index + 2;
        if (next_index >= limiter_buf_size) next_index -= limiter_buf_size;
        const double n0 = fabs(buf[next_index + 0]);
        const double n1 = fabs(buf[next_index + 1]);

        DETECT_PEAK2_CHECK(0, t0, n0);
        DETECT_PEAK2_CHECK(1, t1, n1);

        index += 2;
        if (index >= limiter_buf_size) index -= limiter_buf_size;
    }

#undef DETECT_PEAK2_CHECK
}

extern "C" __device__ void detect_peak_dev(
    double *buf,
    int limiter_buf_size,
    int limiter_buf_index,
    int offset,
    int nb_samples,
    int channels,
    int attack_length,
    double ceiling,
    int frame_type,
    double *prev_smp,
    int *peak_delta,
    double *peak_value,
    int *peak_index,
    double *profile_counts
) {
#if !LOUDNORM_EXACT_GENERIC_LIMITER
    if (channels == 6) {
        detect_peak_6_dev(buf, limiter_buf_size, limiter_buf_index, offset, nb_samples, attack_length, ceiling, frame_type, prev_smp, peak_delta, peak_value, peak_index, profile_counts);
        return;
    }
    if (channels == 2) {
        detect_peak_2_dev(buf, limiter_buf_size, limiter_buf_index, offset, nb_samples, attack_length, ceiling, frame_type, prev_smp, peak_delta, peak_value, peak_index, profile_counts);
        return;
    }
#endif
    *peak_delta = -1;
    if (profile_counts) profile_counts[FB_D_COUNT_DETECT_CALLS] += 1.0;
    int index = limiter_buf_index + (offset * channels) + (attack_length * channels);
    if (index >= limiter_buf_size) index -= limiter_buf_size;

    if (frame_type == 0) {
        for (int c = 0; c < channels; c++) {
            prev_smp[c] = fabs(buf[index + c - channels]);
        }
    }

    for (int n = 0; n < nb_samples; n++) {
        if (profile_counts) profile_counts[FB_D_COUNT_DETECT_FRAMES] += 1.0;
        for (int c = 0; c < channels; c++) {
            int this_index = index + c;
            if (this_index >= limiter_buf_size) this_index -= limiter_buf_size;
            double this_s = fabs(buf[this_index]);
            int next_index = index + c + channels;
            if (next_index >= limiter_buf_size) next_index -= limiter_buf_size;
            double next = fabs(buf[next_index]);
            if ((prev_smp[c] <= this_s) && (next <= this_s) && (this_s > ceiling) && (n > 0)) {
                int detected = 1;
                for (int i = 2; i < 12; i++) {
                    if (profile_counts) profile_counts[FB_D_COUNT_DETECT_LOOKAHEAD] += 1.0;
                    int lookahead_index = index + c + (i * channels);
                    if (lookahead_index >= limiter_buf_size) lookahead_index -= limiter_buf_size;
                    next = fabs(buf[lookahead_index]);
                    if (next > this_s) {
                        detected = 0;
                        break;
                    }
                }
                if (!detected) continue;
                double max_peak = 0.0;
                for (int cc = 0; cc < channels; cc++) {
                    if (cc == 0 || fabs(buf[index + cc]) > max_peak) max_peak = fabs(buf[index + cc]);
                    int prev_index = index + cc;
                    if (prev_index >= limiter_buf_size) prev_index -= limiter_buf_size;
                    prev_smp[cc] = fabs(buf[prev_index]);
                }
                *peak_delta = n;
                *peak_index = index;
                *peak_value = max_peak;
                if (profile_counts) profile_counts[FB_D_COUNT_PEAK_HITS] += 1.0;
                return;
            }
            prev_smp[c] = this_s;
        }
        index += channels;
        if (index >= limiter_buf_size) index -= limiter_buf_size;
    }
}
