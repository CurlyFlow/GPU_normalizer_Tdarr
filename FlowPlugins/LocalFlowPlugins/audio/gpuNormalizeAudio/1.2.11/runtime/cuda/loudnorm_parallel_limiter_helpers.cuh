#define OPX_PARALLEL_LIMITER_MAX_RING_FRAMES 40960U
#define OPX_PARALLEL_LIMITER_MASK_WORDS 1280U

extern "C" __device__ void detect_peak_masked_6_dev(
    const double *buf,
    const unsigned int *ring_exceed_mask,
    unsigned int ring_frames,
    unsigned int output_limiter_index,
    int offset,
    int nb_samples,
    int attack_length,
    double ceiling,
    double *prev_smp,
    int *peak_delta,
    double *peak_value,
    int *peak_index
) {
    *peak_delta = -1;
    if (nb_samples <= 0) return;
    const int ring_f = (int)ring_frames;
    const int buf_size = ring_f * 6;
    int start_frame = (int)output_limiter_index + offset + attack_length;
    while (start_frame < 0) start_frame += ring_f;
    while (start_frame >= ring_f) start_frame -= ring_f;

    int last_checked_n = -1;
    if (nb_samples > 1) {
        const int search_count = nb_samples - 1;
        int first_f = start_frame + 1;
        if (first_f >= ring_f) first_f -= ring_f;
        for (int seg = 0; seg < 2; seg++) {
            int seg_lo;
            int seg_len;
            int seg_n_base;
            if (seg == 0) {
                seg_lo = first_f;
                int avail = ring_f - first_f;
                seg_len = search_count < avail ? search_count : avail;
                seg_n_base = 1;
            } else {
                int seg0_len = ring_f - first_f;
                if (search_count <= seg0_len) break;
                seg_lo = 0;
                seg_len = search_count - seg0_len;
                seg_n_base = 1 + seg0_len;
            }
            const int seg_hi = seg_lo + seg_len;
            const int w_first = seg_lo >> 5;
            const int w_last = (seg_hi - 1) >> 5;
            for (int w = w_first; w <= w_last; w++) {
                unsigned int word = ring_exceed_mask[w];
                if (w == w_first) word &= (~0U << (seg_lo & 31));
                if (w == w_last && (seg_hi & 31)) word &= ((1U << (seg_hi & 31)) - 1U);
                while (word) {
                    const int bit = __ffs((int)word) - 1;
                    word &= word - 1U;
                    const int f = (w << 5) | bit;
                    const int n = seg_n_base + (f - seg_lo);
                    if (last_checked_n != n - 1) {
                        int pf = f - 1;
                        if (pf < 0) pf += ring_f;
                        const int pbase = pf * 6;
                        prev_smp[0] = fabs(buf[pbase + 0]);
                        prev_smp[1] = fabs(buf[pbase + 1]);
                        prev_smp[2] = fabs(buf[pbase + 2]);
                        prev_smp[3] = fabs(buf[pbase + 3]);
                        prev_smp[4] = fabs(buf[pbase + 4]);
                        prev_smp[5] = fabs(buf[pbase + 5]);
                    }
                    const int index = f * 6;
                    const double t0 = fabs(buf[index + 0]);
                    const double t1 = fabs(buf[index + 1]);
                    const double t2 = fabs(buf[index + 2]);
                    const double t3 = fabs(buf[index + 3]);
                    const double t4 = fabs(buf[index + 4]);
                    const double t5 = fabs(buf[index + 5]);
                    int next_index = index + 6;
                    if (next_index >= buf_size) next_index -= buf_size;
                    const double n0 = fabs(buf[next_index + 0]);
                    const double n1 = fabs(buf[next_index + 1]);
                    const double n2 = fabs(buf[next_index + 2]);
                    const double n3 = fabs(buf[next_index + 3]);
                    const double n4 = fabs(buf[next_index + 4]);
                    const double n5 = fabs(buf[next_index + 5]);
                    const double tvals[6] = {t0, t1, t2, t3, t4, t5};
                    const double nvals[6] = {n0, n1, n2, n3, n4, n5};
                    for (int c = 0; c < 6; c++) {
                        int skip_update = 0;
                        if ((prev_smp[c] <= tvals[c]) && (nvals[c] <= tvals[c]) && (tvals[c] > ceiling)) {
                            int detected = 1;
                            for (int i = 2; i < 12; i++) {
                                int lookahead_index = index + c + (i * 6);
                                if (lookahead_index >= buf_size) lookahead_index -= buf_size;
                                if (fabs(buf[lookahead_index]) > tvals[c]) {
                                    detected = 0;
                                    break;
                                }
                            }
                            if (!detected) {
                                skip_update = 1;
                            } else {
                                double max_peak = t0;
                                if (t1 > max_peak) max_peak = t1;
                                if (t2 > max_peak) max_peak = t2;
                                if (t3 > max_peak) max_peak = t3;
                                if (t4 > max_peak) max_peak = t4;
                                if (t5 > max_peak) max_peak = t5;
                                prev_smp[0] = t0;
                                prev_smp[1] = t1;
                                prev_smp[2] = t2;
                                prev_smp[3] = t3;
                                prev_smp[4] = t4;
                                prev_smp[5] = t5;
                                *peak_delta = n;
                                *peak_index = index;
                                *peak_value = max_peak;
                                return;
                            }
                        }
                        if (!skip_update) prev_smp[c] = tvals[c];
                    }
                    last_checked_n = n;
                }
            }
        }
    }
    if (last_checked_n != nb_samples - 1) {
        int last_f = start_frame + nb_samples - 1;
        while (last_f >= ring_f) last_f -= ring_f;
        const int base = last_f * 6;
        prev_smp[0] = fabs(buf[base + 0]);
        prev_smp[1] = fabs(buf[base + 1]);
        prev_smp[2] = fabs(buf[base + 2]);
        prev_smp[3] = fabs(buf[base + 3]);
        prev_smp[4] = fabs(buf[base + 4]);
        prev_smp[5] = fabs(buf[base + 5]);
    }
}

extern "C" __device__ void detect_peak_masked_2_dev(
    const double *buf,
    const unsigned int *ring_exceed_mask,
    unsigned int ring_frames,
    unsigned int output_limiter_index,
    int offset,
    int nb_samples,
    int attack_length,
    double ceiling,
    double *prev_smp,
    int *peak_delta,
    double *peak_value,
    int *peak_index
) {
    *peak_delta = -1;
    if (nb_samples <= 0) return;
    const int ring_f = (int)ring_frames;
    const int buf_size = ring_f * 2;
    int start_frame = (int)output_limiter_index + offset + attack_length;
    while (start_frame < 0) start_frame += ring_f;
    while (start_frame >= ring_f) start_frame -= ring_f;

    int last_checked_n = -1;
    if (nb_samples > 1) {
        const int search_count = nb_samples - 1;
        int first_f = start_frame + 1;
        if (first_f >= ring_f) first_f -= ring_f;
        for (int seg = 0; seg < 2; seg++) {
            int seg_lo;
            int seg_len;
            int seg_n_base;
            if (seg == 0) {
                seg_lo = first_f;
                int avail = ring_f - first_f;
                seg_len = search_count < avail ? search_count : avail;
                seg_n_base = 1;
            } else {
                int seg0_len = ring_f - first_f;
                if (search_count <= seg0_len) break;
                seg_lo = 0;
                seg_len = search_count - seg0_len;
                seg_n_base = 1 + seg0_len;
            }
            const int seg_hi = seg_lo + seg_len;
            const int w_first = seg_lo >> 5;
            const int w_last = (seg_hi - 1) >> 5;
            for (int w = w_first; w <= w_last; w++) {
                unsigned int word = ring_exceed_mask[w];
                if (w == w_first) word &= (~0U << (seg_lo & 31));
                if (w == w_last && (seg_hi & 31)) word &= ((1U << (seg_hi & 31)) - 1U);
                while (word) {
                    const int bit = __ffs((int)word) - 1;
                    word &= word - 1U;
                    const int f = (w << 5) | bit;
                    const int n = seg_n_base + (f - seg_lo);
                    if (last_checked_n != n - 1) {
                        int pf = f - 1;
                        if (pf < 0) pf += ring_f;
                        const int pbase = pf * 2;
                        prev_smp[0] = fabs(buf[pbase + 0]);
                        prev_smp[1] = fabs(buf[pbase + 1]);
                    }
                    const int index = f * 2;
                    const double t0 = fabs(buf[index + 0]);
                    const double t1 = fabs(buf[index + 1]);
                    int next_index = index + 2;
                    if (next_index >= buf_size) next_index -= buf_size;
                    const double n0 = fabs(buf[next_index + 0]);
                    const double n1 = fabs(buf[next_index + 1]);
                    const double tvals[2] = {t0, t1};
                    const double nvals[2] = {n0, n1};
                    for (int c = 0; c < 2; c++) {
                        int skip_update = 0;
                        if ((prev_smp[c] <= tvals[c]) && (nvals[c] <= tvals[c]) && (tvals[c] > ceiling)) {
                            int detected = 1;
                            for (int i = 2; i < 12; i++) {
                                int lookahead_index = index + c + (i * 2);
                                if (lookahead_index >= buf_size) lookahead_index -= buf_size;
                                if (fabs(buf[lookahead_index]) > tvals[c]) {
                                    detected = 0;
                                    break;
                                }
                            }
                            if (!detected) {
                                skip_update = 1;
                            } else {
                                double max_peak = t0 > t1 ? t0 : t1;
                                prev_smp[0] = t0;
                                prev_smp[1] = t1;
                                *peak_delta = n;
                                *peak_index = index;
                                *peak_value = max_peak;
                                return;
                            }
                        }
                        if (!skip_update) prev_smp[c] = tvals[c];
                    }
                    last_checked_n = n;
                }
            }
        }
    }
    if (last_checked_n != nb_samples - 1) {
        int last_f = start_frame + nb_samples - 1;
        while (last_f >= ring_f) last_f -= ring_f;
        const int base = last_f * 2;
        prev_smp[0] = fabs(buf[base + 0]);
        prev_smp[1] = fabs(buf[base + 1]);
    }
}

extern "C" __device__ void parallel_true_peak_limiter_block_dev(
    double *limiter_buf,
    unsigned int *ring_exceed_mask,
    unsigned int nb_samples,
    unsigned int channels,
    unsigned int limiter_lookahead_frames,
    unsigned int output_limiter_index,
    unsigned int attack_length,
    unsigned int release_length,
    double ceiling,
    double *prev_smp,
    int *limiter_state_s,
    int *peak_index_s,
    int *env_index_s,
    int *env_cnt_s,
    int *attack_state_s,
    double *gain_reduction0_s,
    double *gain_reduction1_s
) {
    const unsigned int tid = threadIdx.x;
    const unsigned int stride = blockDim.x;
    const unsigned int warp_id = tid >> 5;
    const unsigned int lane = tid & 31U;
    const unsigned int num_warps = stride >> 5;
    const unsigned int mask_words = (limiter_lookahead_frames + 31U) >> 5;
    const int limiter_buf_size = (int)(limiter_lookahead_frames * channels);

    for (unsigned int w = warp_id; w < mask_words; w += num_warps) {
        const unsigned int f = (w << 5) | lane;
        int exceed = 0;
        if (f < limiter_lookahead_frames) {
            const unsigned long long base = (unsigned long long)f * (unsigned long long)channels;
            if (channels == 6U) {
                const double v0 = limiter_buf[base + 0ULL];
                const double v1 = limiter_buf[base + 1ULL];
                const double v2 = limiter_buf[base + 2ULL];
                const double v3 = limiter_buf[base + 3ULL];
                const double v4 = limiter_buf[base + 4ULL];
                const double v5 = limiter_buf[base + 5ULL];
                exceed = (v0 > ceiling || v0 < -ceiling || v1 > ceiling || v1 < -ceiling ||
                          v2 > ceiling || v2 < -ceiling || v3 > ceiling || v3 < -ceiling ||
                          v4 > ceiling || v4 < -ceiling || v5 > ceiling || v5 < -ceiling) ? 1 : 0;
            } else {
                const double v0 = limiter_buf[base + 0ULL];
                const double v1 = limiter_buf[base + 1ULL];
                exceed = (v0 > ceiling || v0 < -ceiling || v1 > ceiling || v1 < -ceiling) ? 1 : 0;
            }
        }
        const unsigned int bits = __ballot_sync(0xffffffffU, exceed);
        if (lane == 0U) ring_exceed_mask[w] = bits;
    }
    __syncthreads();

    __shared__ int lim_action_s;
    __shared__ int lim_env_index_s;
    __shared__ int lim_env_cnt_start_s;
    __shared__ int lim_count_s;
    __shared__ int lim_denom_s;
    __shared__ double lim_g0_s;
    __shared__ double lim_g1_s;

    int smp_cnt = 0;
    double prev_smp_local[6];
    int limiter_state_work = 0;
    int peak_index_work = 0;
    int env_index_work = 0;
    int env_cnt_work = 0;
    int attack_state_work = 0;
    double gain_reduction0_work = 1.0;
    double gain_reduction1_work = 1.0;

    if (tid == 0U) {
        for (unsigned int c = 0U; c < channels; c++) prev_smp_local[c] = prev_smp[c];
        limiter_state_work = *limiter_state_s;
        peak_index_work = *peak_index_s;
        env_index_work = *env_index_s;
        env_cnt_work = *env_cnt_s;
        attack_state_work = *attack_state_s;
        gain_reduction0_work = *gain_reduction0_s;
        gain_reduction1_work = *gain_reduction1_s;
    }

    while (1) {
        if (tid == 0U) {
            lim_action_s = 0;
            while (smp_cnt < (int)nb_samples) {
                if (limiter_state_work == 0) {
                    int peak_delta = -1;
                    double peak_value = 0.0;
                    if (channels == 6U) {
                        detect_peak_masked_6_dev(
                            limiter_buf, ring_exceed_mask, limiter_lookahead_frames,
                            output_limiter_index, smp_cnt, (int)nb_samples - smp_cnt,
                            attack_state_work, ceiling, prev_smp_local,
                            &peak_delta, &peak_value, &peak_index_work
                        );
                    } else {
                        detect_peak_masked_2_dev(
                            limiter_buf, ring_exceed_mask, limiter_lookahead_frames,
                            output_limiter_index, smp_cnt, (int)nb_samples - smp_cnt,
                            attack_state_work, ceiling, prev_smp_local,
                            &peak_delta, &peak_value, &peak_index_work
                        );
                    }
                    if (peak_delta != -1) {
                        env_cnt_work = 0;
                        smp_cnt += peak_delta - attack_state_work;
                        gain_reduction0_work = 1.0;
                        gain_reduction1_work = __ddiv_rn(ceiling, peak_value);
                        limiter_state_work = 1;
                        env_index_work = peak_index_work - (attack_state_work * (int)channels);
                        if (env_index_work < 0) env_index_work += limiter_buf_size;
                        if (env_index_work > limiter_buf_size) env_index_work -= limiter_buf_size;
                    } else {
                        smp_cnt = (int)nb_samples;
                    }
                } else if (limiter_state_work == 1) {
                    const int rem_env = attack_state_work - env_cnt_work;
                    const int rem_smp = (int)nb_samples - smp_cnt;
                    if (rem_env <= 0) {
                        if (smp_cnt < (int)nb_samples) {
                            env_cnt_work = 0;
                            attack_state_work = (int)attack_length;
                            limiter_state_work = 2;
                        }
                        continue;
                    }
                    const int cnt = rem_env < rem_smp ? rem_env : rem_smp;
                    lim_action_s = 1;
                    lim_env_index_s = env_index_work;
                    lim_env_cnt_start_s = env_cnt_work;
                    lim_count_s = cnt;
                    lim_denom_s = attack_state_work - 1;
                    lim_g0_s = gain_reduction0_work;
                    lim_g1_s = gain_reduction1_work;
                    env_index_work += cnt * (int)channels;
                    while (env_index_work >= limiter_buf_size) env_index_work -= limiter_buf_size;
                    smp_cnt += cnt;
                    env_cnt_work += cnt;
                    if (smp_cnt < (int)nb_samples) {
                        env_cnt_work = 0;
                        attack_state_work = (int)attack_length;
                        limiter_state_work = 2;
                    }
                    break;
                } else if (limiter_state_work == 2) {
                    int peak_delta = -1;
                    double peak_value = 0.0;
                    if (channels == 6U) {
                        detect_peak_masked_6_dev(
                            limiter_buf, ring_exceed_mask, limiter_lookahead_frames,
                            output_limiter_index, smp_cnt, (int)nb_samples,
                            attack_state_work, ceiling, prev_smp_local,
                            &peak_delta, &peak_value, &peak_index_work
                        );
                    } else {
                        detect_peak_masked_2_dev(
                            limiter_buf, ring_exceed_mask, limiter_lookahead_frames,
                            output_limiter_index, smp_cnt, (int)nb_samples,
                            attack_state_work, ceiling, prev_smp_local,
                            &peak_delta, &peak_value, &peak_index_work
                        );
                    }
                    if (peak_delta == -1) {
                        limiter_state_work = 3;
                        gain_reduction0_work = gain_reduction1_work;
                        gain_reduction1_work = 1.0;
                        env_cnt_work = 0;
                    } else {
                        const double gain_reduction = __ddiv_rn(ceiling, peak_value);
                        if (gain_reduction < gain_reduction1_work) {
                            limiter_state_work = 1;
                            attack_state_work = peak_delta;
                            if (attack_state_work <= 1) attack_state_work = 2;
                            gain_reduction0_work = gain_reduction1_work;
                            gain_reduction1_work = gain_reduction;
                            env_cnt_work = 0;
                        } else {
                            const int rem_smp = (int)nb_samples - smp_cnt;
                            const int cnt = peak_delta < rem_smp ? peak_delta : rem_smp;
                            env_cnt_work = cnt;
                            if (cnt > 0) {
                                lim_action_s = 2;
                                lim_env_index_s = env_index_work;
                                lim_count_s = cnt;
                                lim_g1_s = gain_reduction1_work;
                                env_index_work += cnt * (int)channels;
                                while (env_index_work >= limiter_buf_size) env_index_work -= limiter_buf_size;
                                smp_cnt += cnt;
                                break;
                            }
                        }
                    }
                } else {
                    const int rem_env = (int)release_length - env_cnt_work;
                    const int rem_smp = (int)nb_samples - smp_cnt;
                    if (rem_env <= 0) {
                        if (smp_cnt < (int)nb_samples) {
                            env_cnt_work = 0;
                            limiter_state_work = 0;
                        }
                        continue;
                    }
                    const int cnt = rem_env < rem_smp ? rem_env : rem_smp;
                    lim_action_s = 3;
                    lim_env_index_s = env_index_work;
                    lim_env_cnt_start_s = env_cnt_work;
                    lim_count_s = cnt;
                    lim_denom_s = (int)release_length - 1;
                    lim_g0_s = gain_reduction0_work;
                    lim_g1_s = gain_reduction1_work;
                    env_index_work += cnt * (int)channels;
                    while (env_index_work >= limiter_buf_size) env_index_work -= limiter_buf_size;
                    smp_cnt += cnt;
                    env_cnt_work += cnt;
                    if (smp_cnt < (int)nb_samples) {
                        env_cnt_work = 0;
                        limiter_state_work = 0;
                    }
                    break;
                }
            }
        }
        __syncthreads();
        const int action = lim_action_s;
        if (action == 0) break;
        const int cnt = lim_count_s;
        const int base_idx = lim_env_index_s;
        const int cnt_start = lim_env_cnt_start_s;
        const double denom = (double)lim_denom_s;
        const double g0 = lim_g0_s;
        const double g1 = lim_g1_s;
        for (int step = (int)tid; step < cnt; step += (int)stride) {
            double env;
            if (action == 1) {
                const double env_frac = __ddiv_rn((double)(cnt_start + step), denom);
                const double env_delta = __dsub_rn(g0, g1);
                env = __dsub_rn(g0, __dmul_rn(env_frac, env_delta));
            } else if (action == 2) {
                env = g1;
            } else {
                const double env_frac = __ddiv_rn((double)(cnt_start + step), denom);
                const double env_delta = __dsub_rn(g1, g0);
                env = __dadd_rn(g0, __dmul_rn(env_frac, env_delta));
            }
            int pos = base_idx + (step * (int)channels);
            while (pos >= limiter_buf_size) pos -= limiter_buf_size;
            if (channels == 6U) {
                limiter_buf[pos + 0] = __dmul_rn(limiter_buf[pos + 0], env);
                limiter_buf[pos + 1] = __dmul_rn(limiter_buf[pos + 1], env);
                limiter_buf[pos + 2] = __dmul_rn(limiter_buf[pos + 2], env);
                limiter_buf[pos + 3] = __dmul_rn(limiter_buf[pos + 3], env);
                limiter_buf[pos + 4] = __dmul_rn(limiter_buf[pos + 4], env);
                limiter_buf[pos + 5] = __dmul_rn(limiter_buf[pos + 5], env);
            } else {
                limiter_buf[pos + 0] = __dmul_rn(limiter_buf[pos + 0], env);
                limiter_buf[pos + 1] = __dmul_rn(limiter_buf[pos + 1], env);
            }
        }
        __syncthreads();
    }

    if (tid == 0U) {
        *limiter_state_s = limiter_state_work;
        *peak_index_s = peak_index_work;
        *env_index_s = env_index_work;
        *env_cnt_s = env_cnt_work;
        *attack_state_s = attack_state_work;
        *gain_reduction0_s = gain_reduction0_work;
        *gain_reduction1_s = gain_reduction1_work;
        for (unsigned int c = 0U; c < channels; c++) prev_smp[c] = prev_smp_local[c];
    }
}
