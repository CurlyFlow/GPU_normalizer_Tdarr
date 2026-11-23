#ifndef OPX_LOUDNORM_CHANNEL_STATS_MT_H
#define OPX_LOUDNORM_CHANNEL_STATS_MT_H

#include <math.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#if defined(__x86_64__) || defined(__i386__)
#include <immintrin.h>
#endif

#define OPX_STATS_MAX_WORKERS 5

typedef void (*opx_stats_task_fn)(void *ctx, uint32_t ch);

typedef struct {
    pthread_mutex_t call_mu;
    pthread_mutex_t wake_mu;
    pthread_cond_t wake_cv;
    pid_t pid;
    int num_workers;
    uint64_t worker_init_gen[OPX_STATS_MAX_WORKERS + 1];
    _Atomic uint64_t gen;
    _Atomic int done_count;
    uint32_t channels;
    opx_stats_task_fn fn;
    void *ctx;
} OpxStatsPool;

static OpxStatsPool g_stats_pool = {
    .call_mu = PTHREAD_MUTEX_INITIALIZER,
    .wake_mu = PTHREAD_MUTEX_INITIALIZER,
    .wake_cv = PTHREAD_COND_INITIALIZER,
    .pid = 0,
    .num_workers = 0,
    .worker_init_gen = {0},
    .gen = 0,
    .done_count = 0,
    .channels = 0,
    .fn = NULL,
    .ctx = NULL,
};

static void *opx_stats_worker_main(void *raw) {
    const uint32_t tid = (uint32_t)(uintptr_t)raw;
    uint64_t last_gen = g_stats_pool.worker_init_gen[tid];
    for (;;) {
        uint64_t g;
        int spins = 0;
        while ((g = atomic_load_explicit(&g_stats_pool.gen, memory_order_acquire)) == last_gen) {
            if (spins < 256) {
#if defined(__x86_64__) || defined(__i386__)
                _mm_pause();
#endif
                spins++;
            } else {
                pthread_mutex_lock(&g_stats_pool.wake_mu);
                while ((g = atomic_load_explicit(&g_stats_pool.gen, memory_order_acquire)) == last_gen) {
                    pthread_cond_wait(&g_stats_pool.wake_cv, &g_stats_pool.wake_mu);
                }
                pthread_mutex_unlock(&g_stats_pool.wake_mu);
                break;
            }
        }
        last_gen = g;
        const uint32_t channels = g_stats_pool.channels;
        const uint32_t stride = (uint32_t)(g_stats_pool.num_workers + 1);
        opx_stats_task_fn fn = g_stats_pool.fn;
        void *ctx = g_stats_pool.ctx;
        for (uint32_t c = tid; c < channels; c += stride) {
            fn(ctx, c);
        }
        atomic_fetch_add_explicit(&g_stats_pool.done_count, 1, memory_order_release);
    }
    return NULL;
}

static void opx_stats_pool_run(uint32_t channels, opx_stats_task_fn fn, void *ctx) {
    pthread_mutex_lock(&g_stats_pool.call_mu);
    const pid_t self_pid = getpid();
    if (g_stats_pool.pid != self_pid) {
        g_stats_pool.pid = self_pid;
        g_stats_pool.num_workers = 0;
        atomic_store_explicit(&g_stats_pool.gen, 0, memory_order_relaxed);
    }
    int desired = (int)channels - 1;
    if (desired > OPX_STATS_MAX_WORKERS) desired = OPX_STATS_MAX_WORKERS;
    while (g_stats_pool.num_workers < desired) {
        pthread_t th;
        pthread_attr_t attr;
        pthread_attr_init(&attr);
        pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
        const int next_tid = g_stats_pool.num_workers + 1;
        g_stats_pool.worker_init_gen[next_tid] = atomic_load_explicit(&g_stats_pool.gen, memory_order_relaxed);
        if (pthread_create(&th, &attr, opx_stats_worker_main, (void *)(uintptr_t)next_tid) != 0) {
            pthread_attr_destroy(&attr);
            break;
        }
        pthread_attr_destroy(&attr);
        g_stats_pool.num_workers = next_tid;
    }
    if (g_stats_pool.num_workers <= 0) {
        for (uint32_t c = 0U; c < channels; c++) fn(ctx, c);
        pthread_mutex_unlock(&g_stats_pool.call_mu);
        return;
    }

    const int active_workers = g_stats_pool.num_workers;
    g_stats_pool.channels = channels;
    g_stats_pool.fn = fn;
    g_stats_pool.ctx = ctx;
    atomic_store_explicit(&g_stats_pool.done_count, 0, memory_order_relaxed);

    pthread_mutex_lock(&g_stats_pool.wake_mu);
    atomic_fetch_add_explicit(&g_stats_pool.gen, 1, memory_order_release);
    pthread_cond_broadcast(&g_stats_pool.wake_cv);
    pthread_mutex_unlock(&g_stats_pool.wake_mu);

    const uint32_t stride = (uint32_t)(active_workers + 1);
    for (uint32_t c = 0U; c < channels; c += stride) {
        fn(ctx, c);
    }

    int wait_spins = 0;
    while (atomic_load_explicit(&g_stats_pool.done_count, memory_order_acquire) < active_workers) {
        if (wait_spins < 512) {
#if defined(__x86_64__) || defined(__i386__)
            _mm_pause();
#endif
            wait_spins++;
        } else {
            sched_yield();
        }
    }
    pthread_mutex_unlock(&g_stats_pool.call_mu);
}

typedef struct {
    const double *input;
    uint32_t frames;
    uint32_t channels;
    uint32_t input_channels;
    uint32_t channel_offset;
    uint32_t frames_per_window;
    uint32_t global_frame_offset;
    uint32_t first_w;
    uint32_t win_count;
    double *channel_sums;
    uint32_t *ch_peaks;
    double *states;
    double *source_start_states;
    double a1, a2, a3, a4;
    double b0, b1, b2, b3, b4;
} StridedChannelTask;

static void run_strided_channel_task(void *raw, uint32_t c) {
    const StridedChannelTask *t = (const StridedChannelTask *)raw;
    const uint32_t channels = t->channels;
    const uint32_t input_channels = t->input_channels;
    const uint32_t frames_per_window = t->frames_per_window;
    const uint32_t global_frame_offset = t->global_frame_offset;
    const uint32_t first_w = t->first_w;
    const int slot = channel_slot(channels, c);
    const double weight = slot >= 3 ? 1.41 : 1.0;
    const double a1 = t->a1, a2 = t->a2, a3 = t->a3, a4 = t->a4;
    const double b0 = t->b0, b1 = t->b1, b2 = t->b2, b3 = t->b3, b4 = t->b4;

    double v1 = t->states[c * 4U + 0U];
    double v2 = t->states[c * 4U + 1U];
    double v3 = t->states[c * 4U + 2U];
    double v4 = t->states[c * 4U + 3U];
    double window_sum = 0.0;
    uint32_t current_w = first_w;
    uint32_t window_peak_bits = 0U;
    uint32_t *my_peaks = t->ch_peaks + ((uint64_t)c * (uint64_t)t->win_count);

    if (t->source_start_states && channels == 2U && (global_frame_offset % frames_per_window) == 0U) {
        const uint64_t base = (((uint64_t)current_w * 2ULL) + (uint64_t)c) * 4ULL;
        t->source_start_states[base + 0U] = v1;
        t->source_start_states[base + 1U] = v2;
        t->source_start_states[base + 2U] = v3;
        t->source_start_states[base + 3U] = v4;
    }

    const double *src = t->input + (uint64_t)t->channel_offset + (uint64_t)c;
    const uint32_t frames = t->frames;
    for (uint32_t i = 0U; i < frames; i++) {
        const uint32_t w = (global_frame_offset + i) / frames_per_window;
        if (w != current_w) {
            my_peaks[current_w - first_w] = window_peak_bits;
            if (slot >= 0) t->channel_sums[((uint64_t)current_w * (uint64_t)channels) + (uint64_t)c] = window_sum;
            window_sum = 0.0;
            current_w = w;
            window_peak_bits = 0U;
            if (t->source_start_states && channels == 2U) {
                const uint64_t base = (((uint64_t)current_w * 2ULL) + (uint64_t)c) * 4ULL;
                t->source_start_states[base + 0U] = v1;
                t->source_start_states[base + 1U] = v2;
                t->source_start_states[base + 2U] = v3;
                t->source_start_states[base + 3U] = v4;
            }
        }
        const double x = src[(uint64_t)i * (uint64_t)input_channels];
        const uint32_t bits = float_abs_bits(x);
        if (bits > window_peak_bits) window_peak_bits = bits;
        if (slot < 0) continue;

        double v0 = x;
        v0 = v0 - (a1 * v1);
        v0 = v0 - (a2 * v2);
        v0 = v0 - (a3 * v3);
        v0 = v0 - (a4 * v4);
        double y = b0 * v0;
        y = y + (b1 * v1);
        y = y + (b2 * v2);
        y = y + (b3 * v3);
        y = y + (b4 * v4);
        window_sum += y * y * weight;
        v4 = v3;
        v3 = v2;
        v2 = v1;
        v1 = v0;
    }

    if (frames > 0U) {
        my_peaks[current_w - first_w] = window_peak_bits;
        if (slot >= 0) t->channel_sums[((uint64_t)current_w * (uint64_t)channels) + (uint64_t)c] = window_sum;
    }
    t->states[c * 4U + 0U] = v1;
    t->states[c * 4U + 1U] = v2;
    t->states[c * 4U + 2U] = v3;
    t->states[c * 4U + 3U] = v4;
}

static int process_channel_stats_strided_mt(
    const double *input,
    uint32_t frames,
    uint32_t channels,
    uint32_t input_channels,
    uint32_t channel_offset,
    uint32_t frames_per_window,
    uint32_t global_frame_offset,
    double *channel_sums,
    uint32_t *peak_bits,
    double *states,
    double *source_start_states,
    const double *b,
    const double *a
) {
    const uint32_t first_w = global_frame_offset / frames_per_window;
    const uint32_t last_w = (global_frame_offset + frames - 1U) / frames_per_window;
    const uint32_t win_count = last_w - first_w + 1U;
    uint32_t stack_peaks[16 * 64];
    uint32_t *ch_peaks = stack_peaks;
    if (win_count > 64U) {
        ch_peaks = (uint32_t *)calloc((size_t)channels * (size_t)win_count, sizeof(uint32_t));
        if (!ch_peaks) return 4;
    } else {
        memset(stack_peaks, 0, (size_t)channels * (size_t)win_count * sizeof(uint32_t));
    }
    StridedChannelTask task = {
        .input = input,
        .frames = frames,
        .channels = channels,
        .input_channels = input_channels,
        .channel_offset = channel_offset,
        .frames_per_window = frames_per_window,
        .global_frame_offset = global_frame_offset,
        .first_w = first_w,
        .win_count = win_count,
        .channel_sums = channel_sums,
        .ch_peaks = ch_peaks,
        .states = states,
        .source_start_states = source_start_states,
        .a1 = a[1], .a2 = a[2], .a3 = a[3], .a4 = a[4],
        .b0 = b[0], .b1 = b[1], .b2 = b[2], .b3 = b[3], .b4 = b[4],
    };
    opx_stats_pool_run(channels, run_strided_channel_task, &task);
    for (uint32_t k = 0U; k < win_count; k++) {
        uint32_t p = peak_bits[first_w + k];
        for (uint32_t c = 0U; c < channels; c++) {
            const uint32_t cp = ch_peaks[(uint64_t)c * (uint64_t)win_count + (uint64_t)k];
            if (cp > p) p = cp;
        }
        peak_bits[first_w + k] = p;
    }
    if (ch_peaks != stack_peaks) free(ch_peaks);
    return 0;
}

static inline uint64_t swr_reflected_frame_cpu(int64_t frame, uint64_t total_frames) {
    if (total_frames <= 1ULL) return 0ULL;
    while (frame < 0 || (uint64_t)frame >= total_frames) {
        if (frame < 0) frame = -frame;
        else frame = (int64_t)(2ULL * total_frames - 1ULL) - frame;
    }
    return (uint64_t)frame;
}

static inline float swr_dot32_scalar_fma(const float *p, const float *t) {
    float a0 = 0.0f, a1 = 0.0f, a2 = 0.0f, a3 = 0.0f;
    float a4 = 0.0f, a5 = 0.0f, a6 = 0.0f, a7 = 0.0f;
    for (int g = 0; g < 4; g++) {
        const int base = g * 8;
        a0 = fmaf(p[base + 0], t[base + 0], a0);
        a1 = fmaf(p[base + 1], t[base + 1], a1);
        a2 = fmaf(p[base + 2], t[base + 2], a2);
        a3 = fmaf(p[base + 3], t[base + 3], a3);
        a4 = fmaf(p[base + 4], t[base + 4], a4);
        a5 = fmaf(p[base + 5], t[base + 5], a5);
        a6 = fmaf(p[base + 6], t[base + 6], a6);
        a7 = fmaf(p[base + 7], t[base + 7], a7);
    }
    const float s0 = a0 + a4;
    const float s1 = a1 + a5;
    const float s2 = a2 + a6;
    const float s3 = a3 + a7;
    return (s0 + s2) + (s1 + s3);
}

#if defined(__x86_64__) || defined(__i386__)
__attribute__((target("avx2,fma")))
static void swr_upsample_interior_avx2(
    const float *planar,
    uint64_t count,
    const float *t1,
    const float *t2,
    const float *t3,
    double *out4
) {
    const __m256 t1_0 = _mm256_loadu_ps(t1 + 0);
    const __m256 t1_1 = _mm256_loadu_ps(t1 + 8);
    const __m256 t1_2 = _mm256_loadu_ps(t1 + 16);
    const __m256 t1_3 = _mm256_loadu_ps(t1 + 24);
    const __m256 t2_0 = _mm256_loadu_ps(t2 + 0);
    const __m256 t2_1 = _mm256_loadu_ps(t2 + 8);
    const __m256 t2_2 = _mm256_loadu_ps(t2 + 16);
    const __m256 t2_3 = _mm256_loadu_ps(t2 + 24);
    const __m256 t3_0 = _mm256_loadu_ps(t3 + 0);
    const __m256 t3_1 = _mm256_loadu_ps(t3 + 8);
    const __m256 t3_2 = _mm256_loadu_ps(t3 + 16);
    const __m256 t3_3 = _mm256_loadu_ps(t3 + 24);

    for (uint64_t i = 0; i < count; i++) {
        const float *p = planar + i;
        const __m256 x0 = _mm256_loadu_ps(p + 0);
        const __m256 x1 = _mm256_loadu_ps(p + 8);
        const __m256 x2 = _mm256_loadu_ps(p + 16);
        const __m256 x3 = _mm256_loadu_ps(p + 24);

        __m256 va = _mm256_fmadd_ps(x0, t1_0, _mm256_setzero_ps());
        va = _mm256_fmadd_ps(x1, t1_1, va);
        va = _mm256_fmadd_ps(x2, t1_2, va);
        va = _mm256_fmadd_ps(x3, t1_3, va);

        __m256 vb = _mm256_fmadd_ps(x0, t2_0, _mm256_setzero_ps());
        vb = _mm256_fmadd_ps(x1, t2_1, vb);
        vb = _mm256_fmadd_ps(x2, t2_2, vb);
        vb = _mm256_fmadd_ps(x3, t2_3, vb);

        __m256 vc = _mm256_fmadd_ps(x0, t3_0, _mm256_setzero_ps());
        vc = _mm256_fmadd_ps(x1, t3_1, vc);
        vc = _mm256_fmadd_ps(x2, t3_2, vc);
        vc = _mm256_fmadd_ps(x3, t3_3, vc);

        __m128 sa = _mm_add_ps(_mm256_castps256_ps128(va), _mm256_extractf128_ps(va, 1));
        __m128 pa = _mm_add_ps(sa, _mm_movehl_ps(sa, sa));
        const float r1 = _mm_cvtss_f32(_mm_add_ss(pa, _mm_shuffle_ps(pa, pa, 1)));

        __m128 sb = _mm_add_ps(_mm256_castps256_ps128(vb), _mm256_extractf128_ps(vb, 1));
        __m128 pb = _mm_add_ps(sb, _mm_movehl_ps(sb, sb));
        const float r2 = _mm_cvtss_f32(_mm_add_ss(pb, _mm_shuffle_ps(pb, pb, 1)));

        __m128 sc = _mm_add_ps(_mm256_castps256_ps128(vc), _mm256_extractf128_ps(vc, 1));
        __m128 pc = _mm_add_ps(sc, _mm_movehl_ps(sc, sc));
        const float r3 = _mm_cvtss_f32(_mm_add_ss(pc, _mm_shuffle_ps(pc, pc, 1)));

        out4[i * 4ULL + 0ULL] = (double)p[15];
        out4[i * 4ULL + 1ULL] = (double)r1;
        out4[i * 4ULL + 2ULL] = (double)r2;
        out4[i * 4ULL + 3ULL] = (double)r3;
    }
}
#endif

typedef struct {
    const float *input_window;
    uint32_t window_in_frames;
    uint64_t window_start_in_frame;
    uint64_t total_in_frames;
    uint64_t output_start_frame;
    uint64_t output_end_frame;
    uint32_t channels;
    uint32_t frames_per_window;
    uint64_t first_w;
    uint32_t win_count;
    const float *filter_taps;
    double *channel_sums;
    uint32_t *ch_peaks;
    double *states;
    double a1, a2, a3, a4;
    double b0, b1, b2, b3, b4;
    int use_avx2;
    int err;
} Swr48kStatsTask;

static void run_swr48k_stats_channel_task(void *raw, uint32_t c) {
    Swr48kStatsTask *t = (Swr48kStatsTask *)raw;
    const uint32_t channels = t->channels;
    const uint32_t win_in_frames = t->window_in_frames;
    const uint64_t win_start = t->window_start_in_frame;
    const uint64_t total_in = t->total_in_frames;
    const uint64_t out_start = t->output_start_frame;
    const uint64_t out_end = t->output_end_frame;
    const uint32_t fpw = t->frames_per_window;
    const uint64_t first_w = t->first_w;
    const int slot = channel_slot(channels, c);
    const double weight = slot >= 3 ? 1.41 : 1.0;
    const double a1 = t->a1, a2 = t->a2, a3 = t->a3, a4 = t->a4;
    const double b0 = t->b0, b1 = t->b1, b2 = t->b2, b3 = t->b3, b4 = t->b4;

    float *planar = (float *)malloc((size_t)win_in_frames * sizeof(float));
    if (!planar) {
        t->err = 4;
        return;
    }
    const float *src = t->input_window + (uint64_t)c;
    for (uint32_t i = 0U; i < win_in_frames; i++) {
        planar[i] = src[(uint64_t)i * (uint64_t)channels];
    }

    const float *t1 = t->filter_taps + 32;
    const float *t2 = t->filter_taps + 64;
    const float *t3 = t->filter_taps + 96;

    double v1 = t->states[c * 4U + 0U];
    double v2 = t->states[c * 4U + 1U];
    double v3 = t->states[c * 4U + 2U];
    double v4 = t->states[c * 4U + 3U];
    uint64_t current_w = first_w;
    double window_sum = ((out_start % (uint64_t)fpw) != 0ULL && slot >= 0)
        ? t->channel_sums[(current_w * (uint64_t)channels) + (uint64_t)c]
        : 0.0;
    uint32_t window_peak_bits = 0U;
    uint32_t *my_peaks = t->ch_peaks + ((uint64_t)c * (uint64_t)t->win_count);

    const uint64_t k_first = out_start >> 2;
    const uint64_t k_last = (out_end - 1ULL) >> 2;
    double block_out[512 * 4];

    uint64_t k = k_first;
    while (k <= k_last) {
        const int64_t src_start = (int64_t)k - 15LL;
        const int is_interior = (src_start >= 0LL) && ((uint64_t)(src_start + 31LL) < total_in)
            && ((uint64_t)src_start >= win_start)
            && (((uint64_t)src_start - win_start + 32ULL) <= (uint64_t)win_in_frames);
        uint64_t batch = 1ULL;
        if (is_interior) {
            uint64_t max_k = k_last;
            if (total_in > 31ULL && (total_in - 17ULL) < max_k) max_k = total_in - 17ULL;
            const uint64_t win_max_k = win_start + (uint64_t)win_in_frames - 17ULL;
            if (win_max_k < max_k) max_k = win_max_k;
            batch = max_k - k + 1ULL;
            if (batch > 512ULL) batch = 512ULL;
            const float *p = planar + ((uint64_t)src_start - win_start);
#if defined(__x86_64__) || defined(__i386__)
            if (t->use_avx2) {
                swr_upsample_interior_avx2(p, batch, t1, t2, t3, block_out);
            } else
#endif
            {
                for (uint64_t j = 0; j < batch; j++) {
                    const float *pj = p + j;
                    block_out[j * 4ULL + 0ULL] = (double)pj[15];
                    block_out[j * 4ULL + 1ULL] = (double)swr_dot32_scalar_fma(pj, t1);
                    block_out[j * 4ULL + 2ULL] = (double)swr_dot32_scalar_fma(pj, t2);
                    block_out[j * 4ULL + 3ULL] = (double)swr_dot32_scalar_fma(pj, t3);
                }
            }
        } else {
            float ref_buf[32];
            for (int tap = 0; tap < 32; tap++) {
                const uint64_t rf = swr_reflected_frame_cpu(src_start + (int64_t)tap, total_in);
                ref_buf[tap] = planar[rf - win_start];
            }
            block_out[0] = (double)planar[k - win_start];
            block_out[1] = (double)swr_dot32_scalar_fma(ref_buf, t1);
            block_out[2] = (double)swr_dot32_scalar_fma(ref_buf, t2);
            block_out[3] = (double)swr_dot32_scalar_fma(ref_buf, t3);
        }

        const uint64_t out_base = k << 2;
        const uint64_t sample_count = batch << 2;
        for (uint64_t s = 0ULL; s < sample_count; s++) {
            const uint64_t out_idx = out_base + s;
            if (out_idx < out_start || out_idx >= out_end) continue;
            const uint64_t w = out_idx / (uint64_t)fpw;
            if (w != current_w) {
                if (window_peak_bits > my_peaks[current_w - first_w]) my_peaks[current_w - first_w] = window_peak_bits;
                if (slot >= 0) t->channel_sums[(current_w * (uint64_t)channels) + (uint64_t)c] = window_sum;
                window_sum = 0.0;
                current_w = w;
                window_peak_bits = 0U;
            }
            const double x = block_out[s];
            const uint32_t bits = float_abs_bits(x);
            if (bits > window_peak_bits) window_peak_bits = bits;
            if (slot < 0) continue;

            double v0 = x;
            v0 = v0 - (a1 * v1);
            v0 = v0 - (a2 * v2);
            v0 = v0 - (a3 * v3);
            v0 = v0 - (a4 * v4);
            double y = b0 * v0;
            y = y + (b1 * v1);
            y = y + (b2 * v2);
            y = y + (b3 * v3);
            y = y + (b4 * v4);
            window_sum += y * y * weight;
            v4 = v3;
            v3 = v2;
            v2 = v1;
            v1 = v0;
        }
        k += batch;
    }

    if (window_peak_bits > my_peaks[current_w - first_w]) my_peaks[current_w - first_w] = window_peak_bits;
    if (slot >= 0) t->channel_sums[(current_w * (uint64_t)channels) + (uint64_t)c] = window_sum;
    t->states[c * 4U + 0U] = v1;
    t->states[c * 4U + 1U] = v2;
    t->states[c * 4U + 2U] = v3;
    t->states[c * 4U + 3U] = v4;
    free(planar);
}

int opx_loudnorm_channel_stats_48k_f32_to_192k_process(
    const float *input_window,
    uint32_t window_in_frames,
    uint64_t window_start_in_frame,
    uint64_t total_in_frames,
    uint64_t output_start_frame,
    uint64_t output_end_frame,
    uint32_t channels,
    uint32_t frames_per_window,
    const float *filter_taps,
    double *channel_sums,
    uint32_t *peak_bits,
    double *states,
    const double *b,
    const double *a
) {
    if (!input_window || !filter_taps || !channel_sums || !peak_bits || !states || !b || !a) return 1;
    if (channels == 0U || channels > 16U || frames_per_window == 0U || window_in_frames == 0U) return 2;
    if (output_end_frame <= output_start_frame) return 0;

    const uint64_t first_w = output_start_frame / (uint64_t)frames_per_window;
    const uint64_t last_w = (output_end_frame - 1ULL) / (uint64_t)frames_per_window;
    const uint32_t win_count = (uint32_t)(last_w - first_w + 1ULL);
    uint32_t stack_peaks[16 * 64];
    uint32_t *ch_peaks = stack_peaks;
    if (win_count > 64U) {
        ch_peaks = (uint32_t *)calloc((size_t)channels * (size_t)win_count, sizeof(uint32_t));
        if (!ch_peaks) return 4;
    } else {
        memset(stack_peaks, 0, (size_t)channels * (size_t)win_count * sizeof(uint32_t));
    }

    int use_avx2 = 0;
#if defined(__x86_64__) || defined(__i386__)
    if (__builtin_cpu_supports("avx2") && __builtin_cpu_supports("fma")) {
        use_avx2 = 1;
    }
#endif

    Swr48kStatsTask task = {
        .input_window = input_window,
        .window_in_frames = window_in_frames,
        .window_start_in_frame = window_start_in_frame,
        .total_in_frames = total_in_frames,
        .output_start_frame = output_start_frame,
        .output_end_frame = output_end_frame,
        .channels = channels,
        .frames_per_window = frames_per_window,
        .first_w = first_w,
        .win_count = win_count,
        .filter_taps = filter_taps,
        .channel_sums = channel_sums,
        .ch_peaks = ch_peaks,
        .states = states,
        .a1 = a[1], .a2 = a[2], .a3 = a[3], .a4 = a[4],
        .b0 = b[0], .b1 = b[1], .b2 = b[2], .b3 = b[3], .b4 = b[4],
        .use_avx2 = use_avx2,
        .err = 0,
    };

    if (channels >= 2U && (output_end_frame - output_start_frame) >= 4096ULL) {
        opx_stats_pool_run(channels, run_swr48k_stats_channel_task, &task);
    } else {
        for (uint32_t c = 0U; c < channels; c++) run_swr48k_stats_channel_task(&task, c);
    }

    if (task.err == 0) {
        for (uint32_t k = 0U; k < win_count; k++) {
            uint32_t p = peak_bits[first_w + k];
            for (uint32_t c = 0U; c < channels; c++) {
                const uint32_t cp = ch_peaks[(uint64_t)c * (uint64_t)win_count + (uint64_t)k];
                if (cp > p) p = cp;
            }
            peak_bits[first_w + k] = p;
        }
    }
    if (ch_peaks != stack_peaks) free(ch_peaks);
    return task.err;
}

int opx_loudnorm_swr_48k_f32_to_192k_f64_slice(
    const float *input_window,
    uint32_t window_in_frames,
    uint64_t window_start_in_frame,
    uint64_t total_in_frames,
    uint64_t output_start_frame,
    uint64_t output_end_frame,
    uint32_t channels,
    const float *filter_taps,
    double *output_f64
) {
    if (!input_window || !filter_taps || !output_f64) return 1;
    if (channels == 0U || channels > 16U || window_in_frames == 0U) return 2;
    if (output_end_frame <= output_start_frame) return 0;

    const float *t1 = filter_taps + 32;
    const float *t2 = filter_taps + 64;
    const float *t3 = filter_taps + 96;
    const uint64_t k_first = output_start_frame >> 2;
    const uint64_t k_last = (output_end_frame - 1ULL) >> 2;
    float *planar = (float *)malloc((size_t)window_in_frames * sizeof(float));
    if (!planar) return 4;

    int use_avx2 = 0;
#if defined(__x86_64__) || defined(__i386__)
    if (__builtin_cpu_supports("avx2") && __builtin_cpu_supports("fma")) {
        use_avx2 = 1;
    }
#endif

    double block_out[512 * 4];
    for (uint32_t c = 0U; c < channels; c++) {
        const float *src = input_window + (uint64_t)c;
        for (uint32_t i = 0U; i < window_in_frames; i++) {
            planar[i] = src[(uint64_t)i * (uint64_t)channels];
        }
        uint64_t k = k_first;
        while (k <= k_last) {
            const int64_t src_start = (int64_t)k - 15LL;
            const int is_interior = (src_start >= 0LL) && ((uint64_t)(src_start + 31LL) < total_in_frames)
                && ((uint64_t)src_start >= window_start_in_frame)
                && (((uint64_t)src_start - window_start_in_frame + 32ULL) <= (uint64_t)window_in_frames);
            uint64_t batch = 1ULL;
            if (is_interior) {
                uint64_t max_k = k_last;
                if (total_in_frames > 31ULL && (total_in_frames - 17ULL) < max_k) max_k = total_in_frames - 17ULL;
                const uint64_t win_max_k = window_start_in_frame + (uint64_t)window_in_frames - 17ULL;
                if (win_max_k < max_k) max_k = win_max_k;
                batch = max_k - k + 1ULL;
                if (batch > 512ULL) batch = 512ULL;
                const float *p = planar + ((uint64_t)src_start - window_start_in_frame);
#if defined(__x86_64__) || defined(__i386__)
                if (use_avx2) {
                    swr_upsample_interior_avx2(p, batch, t1, t2, t3, block_out);
                } else
#endif
                {
                    for (uint64_t j = 0; j < batch; j++) {
                        const float *pj = p + j;
                        block_out[j * 4ULL + 0ULL] = (double)pj[15];
                        block_out[j * 4ULL + 1ULL] = (double)swr_dot32_scalar_fma(pj, t1);
                        block_out[j * 4ULL + 2ULL] = (double)swr_dot32_scalar_fma(pj, t2);
                        block_out[j * 4ULL + 3ULL] = (double)swr_dot32_scalar_fma(pj, t3);
                    }
                }
            } else {
                float ref_buf[32];
                for (int tap = 0; tap < 32; tap++) {
                    const uint64_t rf = swr_reflected_frame_cpu(src_start + (int64_t)tap, total_in_frames);
                    ref_buf[tap] = planar[rf - window_start_in_frame];
                }
                block_out[0] = (double)planar[k - window_start_in_frame];
                block_out[1] = (double)swr_dot32_scalar_fma(ref_buf, t1);
                block_out[2] = (double)swr_dot32_scalar_fma(ref_buf, t2);
                block_out[3] = (double)swr_dot32_scalar_fma(ref_buf, t3);
            }
            const uint64_t out_base = k << 2;
            const uint64_t sample_count = batch << 2;
            for (uint64_t s = 0ULL; s < sample_count; s++) {
                const uint64_t out_idx = out_base + s;
                if (out_idx < output_start_frame || out_idx >= output_end_frame) continue;
                output_f64[(out_idx - output_start_frame) * (uint64_t)channels + (uint64_t)c] = block_out[s];
            }
            k += batch;
        }
    }
    free(planar);
    return 0;
}

#endif
