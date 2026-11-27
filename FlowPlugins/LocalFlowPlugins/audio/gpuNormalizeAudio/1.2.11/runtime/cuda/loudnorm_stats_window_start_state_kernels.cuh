extern "C" __device__ void kweight_transition_matrix_dev(unsigned int frames, const double *a, double *p) {
    for (int i = 0; i < 16; i++) p[i] = 0.0;
    p[0] = 1.0;
    p[5] = 1.0;
    p[10] = 1.0;
    p[15] = 1.0;
    const double na1 = -a[1];
    const double na2 = -a[2];
    const double na3 = -a[3];
    const double na4 = -a[4];
    for (unsigned int i = 0; i < frames; i++) {
        double r0[4];
        r0[0] = __dadd_rn(__dadd_rn(__dmul_rn(na1, p[0]), __dmul_rn(na2, p[4])), __dadd_rn(__dmul_rn(na3, p[8]), __dmul_rn(na4, p[12])));
        r0[1] = __dadd_rn(__dadd_rn(__dmul_rn(na1, p[1]), __dmul_rn(na2, p[5])), __dadd_rn(__dmul_rn(na3, p[9]), __dmul_rn(na4, p[13])));
        r0[2] = __dadd_rn(__dadd_rn(__dmul_rn(na1, p[2]), __dmul_rn(na2, p[6])), __dadd_rn(__dmul_rn(na3, p[10]), __dmul_rn(na4, p[14])));
        r0[3] = __dadd_rn(__dadd_rn(__dmul_rn(na1, p[3]), __dmul_rn(na2, p[7])), __dadd_rn(__dmul_rn(na3, p[11]), __dmul_rn(na4, p[15])));
        for (int j = 0; j < 4; j++) {
            p[12 + j] = p[8 + j];
            p[8 + j] = p[4 + j];
            p[4 + j] = p[j];
            p[j] = r0[j];
        }
    }
}

extern "C" __global__ void kweight_build_start_states_f64_kernel(
    const double *q_states,
    double *start_states,
    unsigned int windows,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int total_frames,
    const double *a
) {
    const unsigned int c = blockIdx.x;
    if (c >= channels || threadIdx.x != 0) return;
    const int mapped_unused = (channels == 6U && c == 3U);
    double p_full[16];
    double p_last[16];
    kweight_transition_matrix_dev(frames_per_window, a, p_full);
    unsigned int last_len = frames_per_window;
    if (windows > 0U) {
        const unsigned int last_start = (windows - 1U) * frames_per_window;
        last_len = total_frames > last_start ? total_frames - last_start : 0U;
        if (last_len > frames_per_window) last_len = frames_per_window;
    }
    const int needs_last = last_len != frames_per_window;
    if (needs_last) kweight_transition_matrix_dev(last_len, a, p_last);
    double s0 = 0.0;
    double s1 = 0.0;
    double s2 = 0.0;
    double s3 = 0.0;
    for (unsigned int w = 0; w < windows; w++) {
        const unsigned long long base = ((unsigned long long)w * channels + c) * 4ULL;
        start_states[base + 0] = s0;
        start_states[base + 1] = s1;
        start_states[base + 2] = s2;
        start_states[base + 3] = s3;
        if (mapped_unused) continue;
        const double *p = (needs_last && w == windows - 1U) ? p_last : p_full;
        const double q0 = q_states[base + 0];
        const double q1 = q_states[base + 1];
        const double q2 = q_states[base + 2];
        const double q3 = q_states[base + 3];
        const double n0 = __dadd_rn(__dadd_rn(__dadd_rn(__dmul_rn(p[0], s0), __dmul_rn(p[1], s1)), __dadd_rn(__dmul_rn(p[2], s2), __dmul_rn(p[3], s3))), q0);
        const double n1 = __dadd_rn(__dadd_rn(__dadd_rn(__dmul_rn(p[4], s0), __dmul_rn(p[5], s1)), __dadd_rn(__dmul_rn(p[6], s2), __dmul_rn(p[7], s3))), q1);
        const double n2 = __dadd_rn(__dadd_rn(__dadd_rn(__dmul_rn(p[8], s0), __dmul_rn(p[9], s1)), __dadd_rn(__dmul_rn(p[10], s2), __dmul_rn(p[11], s3))), q2);
        const double n3 = __dadd_rn(__dadd_rn(__dadd_rn(__dmul_rn(p[12], s0), __dmul_rn(p[13], s1)), __dadd_rn(__dmul_rn(p[14], s2), __dmul_rn(p[15], s3))), q3);
        s0 = fabs(n0) < 2.2250738585072014e-308 ? 0.0 : n0;
        s1 = fabs(n1) < 2.2250738585072014e-308 ? 0.0 : n1;
        s2 = fabs(n2) < 2.2250738585072014e-308 ? 0.0 : n2;
        s3 = fabs(n3) < 2.2250738585072014e-308 ? 0.0 : n3;
    }
}

extern "C" __global__ void kweight_build_start_states_range_f64_kernel(
    const double *q_states,
    double *start_states,
    unsigned int *state_i,
    double *state_d,
    unsigned int first_window,
    unsigned int window_count,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int total_frames,
    const double *a
) {
    const unsigned int c = blockIdx.x;
    if (c >= channels || threadIdx.x != 0) return;
    const int mapped_unused = (channels == 6U && c == 3U);
    double p_full[16];
    kweight_transition_matrix_dev(frames_per_window, a, p_full);
    double s0 = state_d[(unsigned long long)c * 4ULL + 0ULL];
    double s1 = state_d[(unsigned long long)c * 4ULL + 1ULL];
    double s2 = state_d[(unsigned long long)c * 4ULL + 2ULL];
    double s3 = state_d[(unsigned long long)c * 4ULL + 3ULL];
    for (unsigned int local_w = 0; local_w < window_count; local_w++) {
        const unsigned int global_w = first_window + local_w;
        const unsigned long long base = ((unsigned long long)global_w * channels + c) * 4ULL;
        start_states[base + 0ULL] = s0;
        start_states[base + 1ULL] = s1;
        start_states[base + 2ULL] = s2;
        start_states[base + 3ULL] = s3;
        if (mapped_unused) continue;
        const unsigned int window_start = global_w * frames_per_window;
        unsigned int window_len = total_frames > window_start ? total_frames - window_start : 0U;
        if (window_len > frames_per_window) window_len = frames_per_window;
        const double *p = p_full;
        double p_last[16];
        if (window_len != frames_per_window) {
            kweight_transition_matrix_dev(window_len, a, p_last);
            p = p_last;
        }
        const double q0 = q_states[base + 0ULL];
        const double q1 = q_states[base + 1ULL];
        const double q2 = q_states[base + 2ULL];
        const double q3 = q_states[base + 3ULL];
        const double n0 = __dadd_rn(__dadd_rn(__dadd_rn(__dmul_rn(p[0], s0), __dmul_rn(p[1], s1)), __dadd_rn(__dmul_rn(p[2], s2), __dmul_rn(p[3], s3))), q0);
        const double n1 = __dadd_rn(__dadd_rn(__dadd_rn(__dmul_rn(p[4], s0), __dmul_rn(p[5], s1)), __dadd_rn(__dmul_rn(p[6], s2), __dmul_rn(p[7], s3))), q1);
        const double n2 = __dadd_rn(__dadd_rn(__dadd_rn(__dmul_rn(p[8], s0), __dmul_rn(p[9], s1)), __dadd_rn(__dmul_rn(p[10], s2), __dmul_rn(p[11], s3))), q2);
        const double n3 = __dadd_rn(__dadd_rn(__dadd_rn(__dmul_rn(p[12], s0), __dmul_rn(p[13], s1)), __dadd_rn(__dmul_rn(p[14], s2), __dmul_rn(p[15], s3))), q3);
        s0 = fabs(n0) < 2.2250738585072014e-308 ? 0.0 : n0;
        s1 = fabs(n1) < 2.2250738585072014e-308 ? 0.0 : n1;
        s2 = fabs(n2) < 2.2250738585072014e-308 ? 0.0 : n2;
        s3 = fabs(n3) < 2.2250738585072014e-308 ? 0.0 : n3;
    }
    if (!mapped_unused) {
        state_d[(unsigned long long)c * 4ULL + 0ULL] = s0;
        state_d[(unsigned long long)c * 4ULL + 1ULL] = s1;
        state_d[(unsigned long long)c * 4ULL + 2ULL] = s2;
        state_d[(unsigned long long)c * 4ULL + 3ULL] = s3;
    }
    if (c == 0U) {
        state_i[0] = first_window + window_count;
        state_i[1] = 0U;
        state_d[(unsigned long long)channels * 4ULL] = 0.0;
    }
}

extern "C" __global__ void kweight_build_start_states_range_shared_f64_kernel(
    const double *q_states,
    double *start_states,
    unsigned int *state_i,
    double *state_d,
    unsigned int first_window,
    unsigned int window_count,
    unsigned int channels,
    unsigned int frames_per_window,
    unsigned int total_frames,
    const double *a
) {
    __shared__ double p_full[16];
    __shared__ double p_last[16];
    __shared__ unsigned int last_len_s;
    __shared__ unsigned int needs_last_s;
    if (threadIdx.x == 0U) {
        kweight_transition_matrix_dev(frames_per_window, a, p_full);
        unsigned int last_len = frames_per_window;
        if (window_count > 0U) {
            const unsigned int last_start = (first_window + window_count - 1U) * frames_per_window;
            last_len = total_frames > last_start ? total_frames - last_start : 0U;
            if (last_len > frames_per_window) last_len = frames_per_window;
        }
        last_len_s = last_len;
        needs_last_s = last_len != frames_per_window ? 1U : 0U;
        if (needs_last_s) kweight_transition_matrix_dev(last_len, a, p_last);
    }
    __syncthreads();

    const unsigned int c = threadIdx.x;
    if (c >= channels) {
        if (threadIdx.x == 0U) {
            state_i[0] = first_window + window_count;
            state_i[1] = 0U;
            state_d[(unsigned long long)channels * 4ULL] = 0.0;
        }
        return;
    }
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
    double s0 = state_d[(unsigned long long)c * 4ULL + 0ULL];
    double s1 = state_d[(unsigned long long)c * 4ULL + 1ULL];
    double s2 = state_d[(unsigned long long)c * 4ULL + 2ULL];
    double s3 = state_d[(unsigned long long)c * 4ULL + 3ULL];
    if (slot >= 0) {
        for (unsigned int local_w = 0; local_w < window_count; local_w++) {
            const unsigned int global_w = first_window + local_w;
            const unsigned long long base = ((unsigned long long)global_w * channels + c) * 4ULL;
            start_states[base + 0ULL] = s0;
            start_states[base + 1ULL] = s1;
            start_states[base + 2ULL] = s2;
            start_states[base + 3ULL] = s3;
            const double *p = (needs_last_s && local_w == window_count - 1U && last_len_s != 0U) ? p_last : p_full;
            const double q0 = q_states[base + 0ULL];
            const double q1 = q_states[base + 1ULL];
            const double q2 = q_states[base + 2ULL];
            const double q3 = q_states[base + 3ULL];
            const double n0 = __dadd_rn(__dadd_rn(__dadd_rn(__dmul_rn(p[0], s0), __dmul_rn(p[1], s1)), __dadd_rn(__dmul_rn(p[2], s2), __dmul_rn(p[3], s3))), q0);
            const double n1 = __dadd_rn(__dadd_rn(__dadd_rn(__dmul_rn(p[4], s0), __dmul_rn(p[5], s1)), __dadd_rn(__dmul_rn(p[6], s2), __dmul_rn(p[7], s3))), q1);
            const double n2 = __dadd_rn(__dadd_rn(__dadd_rn(__dmul_rn(p[8], s0), __dmul_rn(p[9], s1)), __dadd_rn(__dmul_rn(p[10], s2), __dmul_rn(p[11], s3))), q2);
            const double n3 = __dadd_rn(__dadd_rn(__dadd_rn(__dmul_rn(p[12], s0), __dmul_rn(p[13], s1)), __dadd_rn(__dmul_rn(p[14], s2), __dmul_rn(p[15], s3))), q3);
            s0 = fabs(n0) < 2.2250738585072014e-308 ? 0.0 : n0;
            s1 = fabs(n1) < 2.2250738585072014e-308 ? 0.0 : n1;
            s2 = fabs(n2) < 2.2250738585072014e-308 ? 0.0 : n2;
            s3 = fabs(n3) < 2.2250738585072014e-308 ? 0.0 : n3;
        }
        state_d[(unsigned long long)c * 4ULL + 0ULL] = s0;
        state_d[(unsigned long long)c * 4ULL + 1ULL] = s1;
        state_d[(unsigned long long)c * 4ULL + 2ULL] = s2;
        state_d[(unsigned long long)c * 4ULL + 3ULL] = s3;
    }
    if (threadIdx.x == 0U) {
        state_i[0] = first_window + window_count;
        state_i[1] = 0U;
        state_d[(unsigned long long)channels * 4ULL] = 0.0;
    }
}
