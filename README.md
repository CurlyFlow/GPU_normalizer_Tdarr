# GPU Normalize Audio for Tdarr

It. Can't. Be done. They said.

GPU Normalize Audio is a Tdarr FlowPlugin plus CUDA runtime for FFmpeg `loudnorm`-style audio normalization.

Each release contains the plugin in a versioned directory:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/<version>/
```

## Plugin

Tdarr loads the JavaScript entrypoint from the versioned CommunityFlowPlugin path:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/<version>/index.js
```

The plugin is named `GPU Normalize Audio`. It normalizes all audio streams, not just the primary stream. Video, subtitles, attachments, data, chapters, and metadata are copied through. Audio streams are processed sequentially so raw PCM intermediates are cleaned after each stream. Long-running decode, GPU normalize, encode, and mux steps report Tdarr worker percentage and ETA updates.

Bundled runtime/source files live under that version's runtime folder:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/<version>/runtime/bin/loudnorm-gpu-source-port
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/<version>/runtime/cuda/compile_cuda_ptx.py
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/<version>/runtime/cuda/loudnorm_source_port_kernels.cu
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/<version>/runtime/cuda/loudnorm_source_port_kernels.ptx
```

## Runtime Layout

Default runtime files stay under the installed version's plugin folder:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/<version>/runtime/bin/loudnorm-source-cpu
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/<version>/runtime/bin/loudnorm-gpu-source-port
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/<version>/runtime/bin/gpu-apply-sample-gains
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/<version>/runtime/cuda/loudnorm_source_port_kernels.ptx
```

Install by keeping runtime files under the same version folder as `index.js`. The plugin inputs still let you override paths if your Tdarr setup needs a different location.

This repository includes the CUDA source-port runtime: `loudnorm-gpu-source-port`, `compile_cuda_ptx.py`, `loudnorm_source_port_kernels.cu`, and `loudnorm_source_port_kernels.ptx`.

`sourceExact` mode also needs compatible `loudnorm-source-cpu` and `gpu-apply-sample-gains` companion binaries in `runtime/bin/`. `gpuSourcePort` uses `loudnorm-gpu-source-port` for the main planner/render path and uses `loudnorm-source-cpu` only for the short-file exact fallback.

## Releases

Download the latest GitHub release asset and extract it into the Tdarr plugins folder. Each release zip includes `FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/<version>/` plus a `.sha256` checksum file.

The repository source is versionless; only release assets use versioned Tdarr plugin folders.

## Modes

- `sourceExact`: uses the source-core loudnorm planner and GPU sample-gain apply path.
- `gpuSourcePort`: uses the CUDA source-port planner and renderer.

The default mode is `sourceExact` for conservative parity. Use `gpuSourcePort` only after validating it on your hardware and media mix.

## Safety Behavior

- `channels=auto` matches each source audio stream's channel count.
- `Enable 2-Channel Track` (`ensureStereo=true`) is enabled by default. If the normalized output would have no 2-channel audio track, the plugin adds a normalized AAC stereo downmix from the first audio stream. Set `ensureStereo=false` to disable this behavior.
- `requireGpuWorker=true` is enabled by default. If Tdarr schedules the plugin on a `Transcode CPU` worker, the plugin fails fast instead of running GPU work under a CPU-worker slot. Use a Worker Type flow gate or GPU-only worker limits for production flows.
- Progress and ETA updates are reported directly from decode, GPU normalize, encode, and mux steps.
- `maxGain` gates excessive gain; when exceeded, the original package is copied instead of normalized.
- `maxPcmMiB` limits decoded raw PCM per audio stream.
- If no audio exists, the plugin skips and returns the original file.

## Performance

Use the newest release unless you need to roll back for your own validation. `1.0.5` is the recommended performance line: it keeps conservative `sourceExact` as the default, keeps `gpuSourcePort` opt-in, and has the best validated long-file GPU result. `1.0.2` is useful only if you specifically want the pair-grid stats-kernel improvement without later runtime changes. `1.0.0` is the baseline package and should only be used when you need the original release behavior.

Version guidance:

| Version | Advice | Performance note |
| --- | --- | --- |
| `1.0.0` | Use only for rollback or baseline comparison. | Original public baseline. Raw `gpuSourcePort` validation reached 99%+ similarity, but long-file runtime was much slower than later versions. |
| `1.0.2` | Use only if `1.0.5` is not suitable for your setup. | Pair-grid stats kernels made the 596s 5.1 raw case about `2.3x` faster than the previous GPU source-port build while keeping the same audio similarity. |
| `1.0.5` | Recommended for new installs. | Best validated line so far: 5.1 60min raw validation reached `99.592%` energy similarity and `9.6x` speedup against the source-exact reference path. |

Raw audio parity against the exact source-core path for the recommended line:

Times below are raw PCM validation results. Full Tdarr jobs also include FFmpeg decode, encode, and mux time.

| Case | Energy similarity | SDR | Source-exact time | GPU time | Speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5.1 12s | 100.000% | 146.441 dB | 1.440s | 1.364s | 1.1x |
| Stereo 60s | 99.555% | 23.519 dB | 1.827s | 0.551s | 3.3x |
| 5.1 60min | 99.592% | 23.889 dB | 419.910s | 43.573s | 9.6x |

Validated plugin behavior includes plugin load/defaults, no-audio skip, max-gain gate, PCM size guard, missing-runtime failure paths, all-audio normalization, and video/subtitle/data/attachment stream preservation.

<img width="1587" height="1443" alt="image" src="https://github.com/user-attachments/assets/9fc7119d-2caa-4bcf-b08b-f857e450f931" />
