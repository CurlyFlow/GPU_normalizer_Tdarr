# GPU Normalizer Tdarr

GPU Normalize Audio is a Tdarr FlowPlugin plus CUDA runtime for FFmpeg `loudnorm`-style audio normalization.

Everything that belongs to the plugin lives in one directory:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.0.0/
```

## Plugin

Tdarr loads the JavaScript entrypoint from the standard CommunityFlowPlugin path:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.0.0/index.js
```

The plugin is named `GPU Normalize Audio`. It normalizes all audio streams, not just the primary stream. Video, subtitles, attachments, data, chapters, and metadata are copied through. Audio streams are processed sequentially so raw PCM intermediates are cleaned after each stream.

Bundled runtime/source files are beside the plugin entrypoint:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.0.0/runtime/bin/loudnorm-gpu-source-port
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.0.0/runtime/cuda/compile_cuda_ptx.py
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.0.0/runtime/cuda/loudnorm_source_port_kernels.cu
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.0.0/runtime/cuda/loudnorm_source_port_kernels.ptx
```

## Runtime Layout

Default install paths inside the Tdarr container:

```text
/app/server/gpu-normalizer/bin/loudnorm-source-cpu
/app/server/gpu-normalizer/bin/loudnorm-gpu-source-port
/app/server/gpu-normalizer/bin/gpu-apply-sample-gains
/app/server/gpu-normalizer/bin/loudnorm_source_port_kernels.ptx
```

Install by copying the files from `runtime/bin` and `runtime/cuda` into that container directory, or set the plugin inputs to your own paths.

`sourceExact` mode also needs compatible `loudnorm-source-cpu` and `gpu-apply-sample-gains` binaries at the configured paths. `gpuSourcePort` uses `loudnorm-gpu-source-port` for the main planner/render path and uses `loudnorm-source-cpu` only for the short-file exact fallback.

## Modes

- `sourceExact`: uses the source-core loudnorm planner and GPU sample-gain apply path.
- `gpuSourcePort`: uses the CUDA source-port planner and renderer.

The default mode is `sourceExact` for conservative parity. Use `gpuSourcePort` only after validating it on your hardware and media mix.

## Safety Behavior

- `channels=auto` matches each source audio stream's channel count.
- `maxGain` gates excessive gain; when exceeded, the original package is copied instead of normalized.
- `maxPcmMiB` limits decoded raw PCM per audio stream.
- If no audio exists, the plugin skips and returns the original file.

## Validation Snapshot

Raw audio parity against the exact source-core path:

| Case | Energy similarity | SDR | CPU time | GPU time | Speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5.1 30s | 99.412% | 22.306 dB | 3.406s | 0.837s | 4.1x |
| Stereo 60s | 99.555% | 23.519 dB | 1.715s | 0.886s | 1.9x |
| 5.1 full 596s | 99.204% | 20.993 dB | 73.708s | 14.966s | 4.9x |

Validated plugin behavior includes plugin load/defaults, no-audio skip, max-gain gate, PCM size guard, missing-runtime failure paths, all-audio normalization, and video/subtitle/data/attachment stream preservation.
