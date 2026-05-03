# GPU_normalizer_Tdarr

Standalone staging repo for the OPX/Tdarr GPU loudnorm source-port canary.

## Current Status

The current `gpuSourcePort` canary is validated against the existing exact
CPU/source-core loudnorm path. The plugin default remains `sourceExact`; the GPU
source-port path is opt-in for canary/testing flows.

Raw audio parity after the latest validation:

| Case | Energy similarity | SDR | CPU time | GPU time | Speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5.1 30s | 99.412% | 22.306 dB | 3.406s | 0.837s | 4.1x |
| Stereo 60s | 99.555% | 23.519 dB | 1.715s | 0.886s | 1.9x |
| 5.1 full 596s | 99.204% | 20.993 dB | 73.708s | 14.966s | 4.9x |

Plugin-level 45s media test:

| Path | Time | Relative |
| --- | ---: | ---: |
| `sourceExact` | 8.920s | baseline |
| `gpuSourcePort` | 5.601s | 1.6x faster |

Real Tdarr dev comparison on the same public 1080p source:

| Path | Time | Relative |
| --- | ---: | ---: |
| CPU built-in normalize | 194.062s | baseline |
| Exact GPU source-core + CUDA apply | 144.826s | 1.3x faster |
| Optimized `gpuSourcePort` | 82.890s | 2.3x faster than CPU, 1.7x faster than exact GPU source-core |

Also validated: plugin load/defaults, no-audio skip, max-gain gate, PCM size
guard, missing-tool failure paths, and video/audio/subtitle/data/attachment
stream preservation.
