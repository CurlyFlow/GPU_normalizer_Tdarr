# GPU_normalizer_Tdarr

It. Cant. Be done, they said. 

Standalone staging repo for the OPX/Tdarr GPU loudnorm source-port normalizer.

## Plugin

Tdarr FlowPlugin path:

```text
FlowPlugins/CommunityFlowPlugins/audio/opxGpuNormalizeAudio/1.0.0/index.js
```

The community plugin is named `OPX GPU Normalize Audio`. It normalizes all audio
streams, not just the primary stream. Video, subtitles, attachments, data,
chapters, and metadata are copied through. Audio streams are processed
sequentially so raw PCM intermediates are cleaned after each stream.

The plugin expects the OPX runtime tools inside the Tdarr container by default:

```text
/app/server/opx/bin/opx-loudnorm-source-cpu.plugin-dev
/app/server/opx/bin/opx-loudnorm-gpu-source-port
/app/server/opx/bin/opx-gpu-apply-sample-gains
/app/server/opx/bin/opx_loudnorm_source_port_kernels.ptx
```

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
guard, missing-tool failure paths, all-audio normalization, and
video/subtitle/data/attachment stream preservation.

Live production test status on 2026-05-04:

| Check | Result |
| --- | --- |
| Live GPU flow copies | Active on the four test-switched live libraries; original flow IDs still exist unchanged |
| Multi-audio smoke | 60s sample with `2,6,6` audio channels normalized all three streams |
| Output shape | `1 video` plus `3 normalized AAC` audio streams; original EAC3 tracks were not copied unnormalized |
| Current live plugin hash | `b02189683f43e02d130d9d51e5078ace9ccc59c24927aab12b4d7af2f19fb525` |
