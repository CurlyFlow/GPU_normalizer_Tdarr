#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>

static int read_frame(FILE *f, uint64_t frame, int channels, float *buf) {
  uint64_t off = frame * (uint64_t)channels * sizeof(float);
  if (fseeko(f, (off_t)off, SEEK_SET) != 0) return 0;
  return fread(buf, sizeof(float), channels, f) == (size_t)channels;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: %s cpu.f32 gpu.f32 [channels] [sample_rate]\n", argv[0]);
    return 2;
  }
  int channels = argc > 3 ? atoi(argv[3]) : 6;
  int sr = argc > 4 ? atoi(argv[4]) : 48000;
  FILE *a = fopen(argv[1], "rb");
  FILE *b = fopen(argv[2], "rb");
  if (!a || !b) {
    perror("fopen");
    return 2;
  }

  const size_t chunk = 1 << 20;
  unsigned char *ab = malloc(chunk);
  unsigned char *bb = malloc(chunk);
  if (!ab || !bb) return 2;

  uint64_t base = 0;
  uint64_t first_byte = UINT64_MAX;
  for (;;) {
    size_t an = fread(ab, 1, chunk, a);
    size_t bn = fread(bb, 1, chunk, b);
    size_t n = an < bn ? an : bn;
    for (size_t i = 0; i < n; i++) {
      if (ab[i] != bb[i]) {
        first_byte = base + i;
        goto found;
      }
    }
    if (an != bn) {
      first_byte = base + n;
      goto found;
    }
    if (an == 0) break;
    base += an;
  }

found:
  if (first_byte == UINT64_MAX) {
    printf("identical\n");
    return 0;
  }

  uint64_t sample = first_byte / 4;
  uint64_t frame = sample / (uint64_t)channels;
  int ch = sample % (uint64_t)channels;
  int byte_in_float = first_byte % 4;
  printf("first_byte0=%llu first_byte1=%llu sample=%llu frame=%llu ch=%d byte_in_float=%d sec=%.6f\n",
         (unsigned long long)first_byte,
         (unsigned long long)(first_byte + 1),
         (unsigned long long)sample,
         (unsigned long long)frame,
         ch,
         byte_in_float,
         (double)frame / (double)sr);

  float fa[16], fb[16];
  uint64_t start = frame > 5 ? frame - 5 : 0;
  for (uint64_t fr = start; fr <= frame + 8; fr++) {
    if (!read_frame(a, fr, channels, fa) || !read_frame(b, fr, channels, fb)) break;
    int diff = 0;
    for (int c = 0; c < channels; c++) {
      if (fa[c] != fb[c]) diff = 1;
    }
    if (diff || (fr >= frame - 1 && fr <= frame + 1)) {
      printf("frame=%llu sec=%.6f", (unsigned long long)fr, (double)fr / (double)sr);
      for (int c = 0; c < channels; c++) {
        printf(" c%d=%.9g/%.9g d=%.9g", c, fa[c], fb[c], fb[c] - fa[c]);
      }
      printf("\n");
    }
  }

  int offsets[] = {-2048, -1024, -512, -256, -128, -64, -32, -16, -8, -4, -2, -1,
                   0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048};
  uint64_t win_frames = 48000;
  uint64_t center = frame > win_frames / 2 ? frame - win_frames / 2 : 0;
  printf("offset_scan start_frame=%llu frames=%llu\n",
         (unsigned long long)center,
         (unsigned long long)win_frames);
  for (size_t oi = 0; oi < sizeof(offsets) / sizeof(offsets[0]); oi++) {
    int off = offsets[oi];
    double sum = 0.0;
    double maxd = 0.0;
    uint64_t count = 0;
    uint64_t eq = 0;
    for (uint64_t fr = 0; fr < win_frames; fr++) {
      int64_t gfr = (int64_t)(center + fr) + off;
      if (gfr < 0) continue;
      if (!read_frame(a, center + fr, channels, fa) || !read_frame(b, (uint64_t)gfr, channels, fb)) break;
      for (int c = 0; c < channels; c++) {
        double d = (double)fb[c] - (double)fa[c];
        sum += d * d;
        double ad = fabs(d);
        if (ad > maxd) maxd = ad;
        if (fa[c] == fb[c]) eq++;
        count++;
      }
    }
    if (count) {
      printf("off=%d rms=%.12g max=%.12g eq=%.6f\n",
             off,
             sqrt(sum / (double)count),
             maxd,
             (double)eq / (double)count);
    }
  }

  return 0;
}
