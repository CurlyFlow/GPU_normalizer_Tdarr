# Audio Parity Diagnostics

Standalone diagnostic tools for verifying sample-accurate decoded PCM (`f32le`) parity between FFmpeg CPU `loudnorm` reference output and GPU-normalized output.

## Tools

### `first_diff_f32.c`

Scans two interleaved 32-bit float PCM (`f32le`) streams and reports the first differing byte/frame, maximum absolute delta, and surrounding channel values.

```bash
cc -O2 -Wall -Wextra -o first_diff_f32 diagnostics/first_diff_f32.c -lm
./first_diff_f32 cpu.f32 gpu.f32 6 48000
```

### `analyze_f32_diff.js`

Inspects a specific byte offset in two interleaved `f32le` PCM files and prints the sample index, frame index, timestamp, and surrounding frames.

```bash
node diagnostics/analyze_f32_diff.js cpu.f32 gpu.f32 <firstByteOffset> 6 48000
```
