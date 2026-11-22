static __device__ __forceinline__ unsigned long long swr_reflected_frame(
    long long frame,
    unsigned long long total_frames
) {
    if (total_frames <= 1ULL) return 0ULL;
    while (frame < 0 || (unsigned long long)frame >= total_frames) {
        if (frame < 0) frame = -frame;
        else frame = (long long)(2ULL * total_frames - 1ULL) - frame;
    }
    return (unsigned long long)frame;
}

extern "C" __global__ void swr_downsample_192k_to_96k_f32_kernel(
    const double* input,
    const double* filter,
    float* output,
    unsigned long long window_start_frame,
    unsigned long long total_source_frames,
    unsigned long long output_start_frame,
    unsigned long long output_count,
    unsigned int channels
) {
    const unsigned long long flat = (unsigned long long)blockIdx.x * (unsigned long long)blockDim.x + (unsigned long long)threadIdx.x;
    const unsigned long long total_values = output_count * (unsigned long long)channels;
    if (flat >= total_values) return;

    const unsigned long long local_out = flat / (unsigned long long)channels;
    const unsigned int ch = (unsigned int)(flat - local_out * (unsigned long long)channels);
    const unsigned long long global_out = output_start_frame + local_out;
    const long long source_start = (long long)(2ULL * global_out) - 32LL;

    double lane0 = 0.0;
    double lane1 = 0.0;
    double lane2 = 0.0;
    double lane3 = 0.0;

    #pragma unroll 4
    for (int group = 0; group < 17; ++group) {
        const int tap = group * 4;
        const unsigned long long f0 = swr_reflected_frame(source_start + (long long)tap, total_source_frames) - window_start_frame;
        const unsigned long long f1 = swr_reflected_frame(source_start + (long long)(tap + 1), total_source_frames) - window_start_frame;
        const unsigned long long f2 = swr_reflected_frame(source_start + (long long)(tap + 2), total_source_frames) - window_start_frame;
        const unsigned long long f3 = swr_reflected_frame(source_start + (long long)(tap + 3), total_source_frames) - window_start_frame;
        lane0 = __fma_rn(input[f0 * (unsigned long long)channels + (unsigned long long)ch], filter[tap], lane0);
        lane1 = __fma_rn(input[f1 * (unsigned long long)channels + (unsigned long long)ch], filter[tap + 1], lane1);
        lane2 = __fma_rn(input[f2 * (unsigned long long)channels + (unsigned long long)ch], filter[tap + 2], lane2);
        lane3 = __fma_rn(input[f3 * (unsigned long long)channels + (unsigned long long)ch], filter[tap + 3], lane3);
    }

    const double pair0 = __dadd_rn(lane0, lane2);
    const double pair1 = __dadd_rn(lane1, lane3);
    output[flat] = __double2float_rn(__dadd_rn(pair0, pair1));
}

extern "C" __global__ void swr_upsample_48k_to_192k_f32_to_f64_kernel(
    const float* __restrict__ input,
    const float* __restrict__ filter,
    double* __restrict__ output,
    unsigned long long window_start_in_frame,
    unsigned long long total_in_frames,
    unsigned long long output_start_frame,
    unsigned long long output_count,
    unsigned int channels
) {
    if (output_count == 0ULL) return;
    const unsigned long long k_first = output_start_frame >> 2;
    const unsigned long long output_end_frame = output_start_frame + output_count;
    const unsigned long long k_last = (output_end_frame - 1ULL) >> 2;
    const unsigned long long k_count = k_last - k_first + 1ULL;
    const unsigned long long flat = (unsigned long long)blockIdx.x * (unsigned long long)blockDim.x + (unsigned long long)threadIdx.x;
    const unsigned long long total_work = k_count * (unsigned long long)channels;
    if (flat >= total_work) return;

    const unsigned long long local_k = flat / (unsigned long long)channels;
    const unsigned int ch = (unsigned int)(flat - local_k * (unsigned long long)channels);
    const unsigned long long k = k_first + local_k;
    const unsigned long long ch_ull = (unsigned long long)channels;
    const unsigned long long out_base_global = k << 2;

    const float* t1 = filter + 32ULL;
    const float* t2 = filter + 64ULL;
    const float* t3 = filter + 96ULL;

    float a0 = 0.0f, a1 = 0.0f, a2 = 0.0f, a3 = 0.0f, a4 = 0.0f, a5 = 0.0f, a6 = 0.0f, a7 = 0.0f;
    float b0 = 0.0f, b1 = 0.0f, b2 = 0.0f, b3 = 0.0f, b4 = 0.0f, b5 = 0.0f, b6 = 0.0f, b7 = 0.0f;
    float c0 = 0.0f, c1 = 0.0f, c2 = 0.0f, c3 = 0.0f, c4 = 0.0f, c5 = 0.0f, c6 = 0.0f, c7 = 0.0f;

    const long long src_start = (long long)k - 15LL;
    const bool interior = (src_start >= 0LL) && ((unsigned long long)(src_start + 31LL) < total_in_frames);
    float center_val = 0.0f;

    if (interior) {
        const float* p = input + ((unsigned long long)src_start - window_start_in_frame) * ch_ull + (unsigned long long)ch;
        center_val = p[15ULL * ch_ull];
        #pragma unroll
        for (int g = 0; g < 4; ++g) {
            const int base = g * 8;
            const float x0 = p[(unsigned long long)(base + 0) * ch_ull];
            const float x1 = p[(unsigned long long)(base + 1) * ch_ull];
            const float x2 = p[(unsigned long long)(base + 2) * ch_ull];
            const float x3 = p[(unsigned long long)(base + 3) * ch_ull];
            const float x4 = p[(unsigned long long)(base + 4) * ch_ull];
            const float x5 = p[(unsigned long long)(base + 5) * ch_ull];
            const float x6 = p[(unsigned long long)(base + 6) * ch_ull];
            const float x7 = p[(unsigned long long)(base + 7) * ch_ull];

            a0 = __fmaf_rn(x0, __ldg(t1 + base + 0), a0);
            a1 = __fmaf_rn(x1, __ldg(t1 + base + 1), a1);
            a2 = __fmaf_rn(x2, __ldg(t1 + base + 2), a2);
            a3 = __fmaf_rn(x3, __ldg(t1 + base + 3), a3);
            a4 = __fmaf_rn(x4, __ldg(t1 + base + 4), a4);
            a5 = __fmaf_rn(x5, __ldg(t1 + base + 5), a5);
            a6 = __fmaf_rn(x6, __ldg(t1 + base + 6), a6);
            a7 = __fmaf_rn(x7, __ldg(t1 + base + 7), a7);

            b0 = __fmaf_rn(x0, __ldg(t2 + base + 0), b0);
            b1 = __fmaf_rn(x1, __ldg(t2 + base + 1), b1);
            b2 = __fmaf_rn(x2, __ldg(t2 + base + 2), b2);
            b3 = __fmaf_rn(x3, __ldg(t2 + base + 3), b3);
            b4 = __fmaf_rn(x4, __ldg(t2 + base + 4), b4);
            b5 = __fmaf_rn(x5, __ldg(t2 + base + 5), b5);
            b6 = __fmaf_rn(x6, __ldg(t2 + base + 6), b6);
            b7 = __fmaf_rn(x7, __ldg(t2 + base + 7), b7);

            c0 = __fmaf_rn(x0, __ldg(t3 + base + 0), c0);
            c1 = __fmaf_rn(x1, __ldg(t3 + base + 1), c1);
            c2 = __fmaf_rn(x2, __ldg(t3 + base + 2), c2);
            c3 = __fmaf_rn(x3, __ldg(t3 + base + 3), c3);
            c4 = __fmaf_rn(x4, __ldg(t3 + base + 4), c4);
            c5 = __fmaf_rn(x5, __ldg(t3 + base + 5), c5);
            c6 = __fmaf_rn(x6, __ldg(t3 + base + 6), c6);
            c7 = __fmaf_rn(x7, __ldg(t3 + base + 7), c7);
        }
    } else {
        center_val = input[(k - window_start_in_frame) * ch_ull + (unsigned long long)ch];
        #pragma unroll
        for (int g = 0; g < 4; ++g) {
            const int base = g * 8;
            const float x0 = input[(swr_reflected_frame(src_start + (long long)(base + 0), total_in_frames) - window_start_in_frame) * ch_ull + (unsigned long long)ch];
            const float x1 = input[(swr_reflected_frame(src_start + (long long)(base + 1), total_in_frames) - window_start_in_frame) * ch_ull + (unsigned long long)ch];
            const float x2 = input[(swr_reflected_frame(src_start + (long long)(base + 2), total_in_frames) - window_start_in_frame) * ch_ull + (unsigned long long)ch];
            const float x3 = input[(swr_reflected_frame(src_start + (long long)(base + 3), total_in_frames) - window_start_in_frame) * ch_ull + (unsigned long long)ch];
            const float x4 = input[(swr_reflected_frame(src_start + (long long)(base + 4), total_in_frames) - window_start_in_frame) * ch_ull + (unsigned long long)ch];
            const float x5 = input[(swr_reflected_frame(src_start + (long long)(base + 5), total_in_frames) - window_start_in_frame) * ch_ull + (unsigned long long)ch];
            const float x6 = input[(swr_reflected_frame(src_start + (long long)(base + 6), total_in_frames) - window_start_in_frame) * ch_ull + (unsigned long long)ch];
            const float x7 = input[(swr_reflected_frame(src_start + (long long)(base + 7), total_in_frames) - window_start_in_frame) * ch_ull + (unsigned long long)ch];

            a0 = __fmaf_rn(x0, __ldg(t1 + base + 0), a0);
            a1 = __fmaf_rn(x1, __ldg(t1 + base + 1), a1);
            a2 = __fmaf_rn(x2, __ldg(t1 + base + 2), a2);
            a3 = __fmaf_rn(x3, __ldg(t1 + base + 3), a3);
            a4 = __fmaf_rn(x4, __ldg(t1 + base + 4), a4);
            a5 = __fmaf_rn(x5, __ldg(t1 + base + 5), a5);
            a6 = __fmaf_rn(x6, __ldg(t1 + base + 6), a6);
            a7 = __fmaf_rn(x7, __ldg(t1 + base + 7), a7);

            b0 = __fmaf_rn(x0, __ldg(t2 + base + 0), b0);
            b1 = __fmaf_rn(x1, __ldg(t2 + base + 1), b1);
            b2 = __fmaf_rn(x2, __ldg(t2 + base + 2), b2);
            b3 = __fmaf_rn(x3, __ldg(t2 + base + 3), b3);
            b4 = __fmaf_rn(x4, __ldg(t2 + base + 4), b4);
            b5 = __fmaf_rn(x5, __ldg(t2 + base + 5), b5);
            b6 = __fmaf_rn(x6, __ldg(t2 + base + 6), b6);
            b7 = __fmaf_rn(x7, __ldg(t2 + base + 7), b7);

            c0 = __fmaf_rn(x0, __ldg(t3 + base + 0), c0);
            c1 = __fmaf_rn(x1, __ldg(t3 + base + 1), c1);
            c2 = __fmaf_rn(x2, __ldg(t3 + base + 2), c2);
            c3 = __fmaf_rn(x3, __ldg(t3 + base + 3), c3);
            c4 = __fmaf_rn(x4, __ldg(t3 + base + 4), c4);
            c5 = __fmaf_rn(x5, __ldg(t3 + base + 5), c5);
            c6 = __fmaf_rn(x6, __ldg(t3 + base + 6), c6);
            c7 = __fmaf_rn(x7, __ldg(t3 + base + 7), c7);
        }
    }

    if (out_base_global >= output_start_frame && out_base_global < output_end_frame) {
        output[(out_base_global - output_start_frame) * ch_ull + (unsigned long long)ch] = (double)center_val;
    }
    if (out_base_global + 1ULL >= output_start_frame && out_base_global + 1ULL < output_end_frame) {
        const float s0 = __fadd_rn(a0, a4);
        const float s1 = __fadd_rn(a1, a5);
        const float s2 = __fadd_rn(a2, a6);
        const float s3 = __fadd_rn(a3, a7);
        output[(out_base_global + 1ULL - output_start_frame) * ch_ull + (unsigned long long)ch] = (double)__fadd_rn(__fadd_rn(s0, s2), __fadd_rn(s1, s3));
    }
    if (out_base_global + 2ULL >= output_start_frame && out_base_global + 2ULL < output_end_frame) {
        const float s0 = __fadd_rn(b0, b4);
        const float s1 = __fadd_rn(b1, b5);
        const float s2 = __fadd_rn(b2, b6);
        const float s3 = __fadd_rn(b3, b7);
        output[(out_base_global + 2ULL - output_start_frame) * ch_ull + (unsigned long long)ch] = (double)__fadd_rn(__fadd_rn(s0, s2), __fadd_rn(s1, s3));
    }
    if (out_base_global + 3ULL >= output_start_frame && out_base_global + 3ULL < output_end_frame) {
        const float s0 = __fadd_rn(c0, c4);
        const float s1 = __fadd_rn(c1, c5);
        const float s2 = __fadd_rn(c2, c6);
        const float s3 = __fadd_rn(c3, c7);
        output[(out_base_global + 3ULL - output_start_frame) * ch_ull + (unsigned long long)ch] = (double)__fadd_rn(__fadd_rn(s0, s2), __fadd_rn(s1, s3));
    }
}
