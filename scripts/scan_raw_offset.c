#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static float *read_file(const char *path, size_t *samples) {
    FILE *f = fopen(path, "rb");
    if (!f) { perror(path); exit(2); }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0 || sz % 4) { fprintf(stderr, "bad f32 file %s\n", path); exit(2); }
    *samples = (size_t)sz / 4;
    float *p = malloc((size_t)sz);
    if (!p) { fprintf(stderr, "malloc failed\n"); exit(2); }
    if (fread(p, 4, *samples, f) != *samples) { fprintf(stderr, "read failed\n"); exit(2); }
    fclose(f);
    return p;
}

int main(int argc, char **argv) {
    if (argc != 8) {
        fprintf(stderr, "usage: scan_raw_offset ref.f32 cand.f32 channels rate min_ms max_ms step_ms\n");
        return 2;
    }
    int ch = atoi(argv[3]);
    int rate = atoi(argv[4]);
    int min_ms = atoi(argv[5]);
    int max_ms = atoi(argv[6]);
    int step_ms = atoi(argv[7]);
    size_t rn = 0, cn = 0;
    float *r = read_file(argv[1], &rn);
    float *c = read_file(argv[2], &cn);
    double best_sdr = -999.0, best_sim = 0.0;
    int best_ms = 0, best_frames = 0;
    for (int ms = min_ms; ms <= max_ms; ms += step_ms) {
        int frame_offset = (int)llround((double)rate * (double)ms / 1000.0);
        size_t rs = 0, cs = 0;
        if (frame_offset >= 0) rs = (size_t)frame_offset * (size_t)ch;
        else cs = (size_t)(-frame_offset) * (size_t)ch;
        if (rs >= rn || cs >= cn) continue;
        size_t n = rn - rs;
        if (cn - cs < n) n = cn - cs;
        double ss = 0.0, dd = 0.0;
        for (size_t i = 0; i < n; i++) {
            double x = r[rs + i];
            double y = c[cs + i];
            double d = x - y;
            ss += x * x;
            dd += d * d;
        }
        double sdr = (dd > 0.0 && ss > 0.0) ? 10.0 * log10(ss / dd) : 999.0;
        double sim = ss > 0.0 ? 1.0 - dd / ss : 0.0;
        if (sdr > best_sdr) {
            best_sdr = sdr;
            best_sim = sim;
            best_ms = ms;
            best_frames = frame_offset;
        }
    }
    printf("best_sdr_db=%.6f energy_similarity=%.12f offset_ms=%d frame_offset=%d\n", best_sdr, best_sim, best_ms, best_frames);
    free(r);
    free(c);
    return 0;
}
