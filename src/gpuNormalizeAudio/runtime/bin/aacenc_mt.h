#ifndef AVCODEC_AACENC_MT_H
#define AVCODEC_AACENC_MT_H

#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <unistd.h>
#if defined(__x86_64__) || defined(__i386__)
#include <immintrin.h>
#define AAC_MT_PAUSE() _mm_pause()
#else
#define AAC_MT_PAUSE() ((void)0)
#endif

typedef void (*aac_mt_task_fn)(void *arg, int ch_idx);

typedef struct AACMtPool {
    int n_channels;
    int n_threads; /* total workers including main thread (index 0) */
    AACEncContext *workers; /* array of n_channels per-channel contexts */
    pthread_t threads[AAC_MAX_CHANNELS];

    _Atomic uint64_t gen;
    _Atomic int done_count;
    _Atomic int stop;

    aac_mt_task_fn task_fn;
    void *task_arg;
} AACMtPool;

typedef struct AACMtWorkerArg {
    AACMtPool *pool;
    int tid;
} AACMtWorkerArg;

static void *aac_mt_worker_main(void *raw)
{
    AACMtWorkerArg *warg = (AACMtWorkerArg *)raw;
    AACMtPool *pool = warg->pool;
    int tid = warg->tid;
    uint64_t last_gen = 0;

    av_free(warg);

    for (;;) {
        uint64_t g;
        int spins = 0;
        while ((g = atomic_load_explicit(&pool->gen, memory_order_acquire)) == last_gen) {
            if (atomic_load_explicit(&pool->stop, memory_order_relaxed))
                return NULL;
            if (spins < 65536) {
                AAC_MT_PAUSE();
                spins++;
            } else {
                usleep(50);
            }
        }
        if (atomic_load_explicit(&pool->stop, memory_order_acquire))
            return NULL;

        last_gen = g;
        for (int ch = tid; ch < pool->n_channels; ch += pool->n_threads) {
            pool->task_fn(pool->task_arg, ch);
        }
        atomic_fetch_add_explicit(&pool->done_count, 1, memory_order_release);
    }
    return NULL;
}

static av_cold int aac_mt_init(AACEncContext *s, int requested_threads)
{
    int n_ch = s->channels;
    int n_th;
    AACMtPool *pool;

    if (requested_threads <= 1 || n_ch < 2 || n_ch > AAC_MAX_CHANNELS)
        return 0;

    n_th = requested_threads < n_ch ? requested_threads : n_ch;
    if (n_th <= 1)
        return 0;

    pool = av_mallocz(sizeof(*pool));
    if (!pool)
        return AVERROR(ENOMEM);

    pool->n_channels = n_ch;
    pool->n_threads = n_th;
    pool->workers = av_calloc(n_ch, sizeof(AACEncContext));
    if (!pool->workers) {
        av_free(pool);
        return AVERROR(ENOMEM);
    }

    for (int c = 0; c < n_ch; c++) {
        pool->workers[c] = *s;
        pool->workers[c].mt_pool = NULL;
        pool->workers[c].quantize_band_cost_cache_generation = 0;
        memset(pool->workers[c].quantize_band_cost_cache, 0,
               sizeof(pool->workers[c].quantize_band_cost_cache));
    }

    atomic_init(&pool->gen, 0);
    atomic_init(&pool->done_count, 0);
    atomic_init(&pool->stop, 0);

    for (int t = 1; t < n_th; t++) {
        AACMtWorkerArg *warg = av_malloc(sizeof(*warg));
        if (!warg) {
            pool->n_threads = t;
            break;
        }
        warg->pool = pool;
        warg->tid = t;
        if (pthread_create(&pool->threads[t], NULL, aac_mt_worker_main, warg) != 0) {
            av_free(warg);
            pool->n_threads = t;
            break;
        }
    }

    s->mt_pool = pool;
    return 0;
}

static void aac_mt_dispatch(AACMtPool *pool, aac_mt_task_fn fn, void *arg)
{
    int workers_needed = pool->n_threads - 1;
    uint64_t next_gen;

    pool->task_fn = fn;
    pool->task_arg = arg;
    atomic_store_explicit(&pool->done_count, 0, memory_order_relaxed);
    next_gen = atomic_load_explicit(&pool->gen, memory_order_relaxed) + 1;
    atomic_store_explicit(&pool->gen, next_gen, memory_order_release);

    for (int ch = 0; ch < pool->n_channels; ch += pool->n_threads) {
        fn(arg, ch);
    }

    while (atomic_load_explicit(&pool->done_count, memory_order_acquire) < workers_needed) {
        AAC_MT_PAUSE();
    }
}

static av_cold void aac_mt_free(AACEncContext *s)
{
    AACMtPool *pool = s->mt_pool;
    if (!pool)
        return;

    atomic_store_explicit(&pool->stop, 1, memory_order_release);
    atomic_fetch_add_explicit(&pool->gen, 1, memory_order_release);
    for (int t = 1; t < pool->n_threads; t++) {
        pthread_join(pool->threads[t], NULL);
    }
    av_freep(&pool->workers);
    av_freep(&s->mt_pool);
}

#endif /* AVCODEC_AACENC_MT_H */
