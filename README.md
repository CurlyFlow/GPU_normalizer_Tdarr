# GPU Normalize Audio for Tdarr

WARNING: WORK IN PROGRES, THERE MIGHT BE RISK OF BUGS. 

It. Can't. Be done. They said.

GPU Normalize Audio is a Tdarr FlowPlugin plus CUDA runtime for FFmpeg `loudnorm`-style audio normalization.

Each release contains the plugin in a versioned directory. Keep that version directory when installing; it is intentional so multiple versions can coexist and roll back cleanly:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/<version>/
```

For example, the current stable release `v1.1.1` installs as:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.1.1/
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

`gpuSourcePort` is the default planner/render path. It uses `loudnorm-gpu-source-port` for CUDA loudness planning and rendering, and uses `loudnorm-source-cpu` only for the short-file exact fallback. `sourceExact` remains available as a compatibility mode and needs compatible `loudnorm-source-cpu` and `gpu-apply-sample-gains` companion binaries in `runtime/bin/`.

## Releases

Download the latest GitHub release asset and extract it into the Tdarr plugins folder. Each release zip includes one versioned plugin folder such as `FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.0/` plus a `.sha256` checksum file. Do not flatten the files into `gpuNormalizeAudio/`; keep each release under its own version folder.

The repository keeps published source snapshots under `FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/<version>/` so GitHub shows every released version folder.

## Modes

- `gpuSourcePort`: default. Uses the CUDA source-port planner and renderer.
- `sourceExact`: compatibility mode. Uses the source-core loudnorm planner and GPU sample-gain apply path.

The default mode is `gpuSourcePort`.

## Safety Behavior

- `channels=auto` matches each source audio stream's channel count.
- `Enable 2-Channel Track` (`ensureStereo=true`) is enabled by default. If the normalized output would have no 2-channel audio track, the plugin adds a normalized AAC stereo downmix from the first audio stream. Set `ensureStereo=false` to disable this behavior.
- `requireGpuWorker=true` is enabled by default. If Tdarr schedules the plugin on a `Transcode CPU` worker, the plugin fails fast instead of running GPU work under a CPU-worker slot. Use a Worker Type flow gate or GPU-only worker limits for production flows.
- `Max Concurrent Jobs` defaults to `1`. The plugin uses guarded slot lock directories with heartbeat/stale cleanup so only the configured number of GPU normalize jobs run for the same `Lock File` base path. Set `Max Concurrent Jobs=0` to disable this guard.
- Progress and ETA updates are reported directly from decode, GPU normalize, encode, and mux steps.
- `maxGain` gates excessive gain; when exceeded, the original package is copied instead of normalized.
- `maxPcmMiB` limits decoded raw PCM per audio stream.
- If no audio exists, the plugin skips and returns the original file.

## Performance

Use the newest release unless you need to roll back for your own validation. `1.0` is the first stable line focused on matching Tdarr's CPU-only `Normalize Audio` output. `1.1` keeps that correctness target and improves the exact CUDA apply path on short 5.1 benchmarks, but measured GPU runtime remains slower than CPU. `1.1.1` keeps the `1.1` audio path and adds guarded, configurable GPU normalize concurrency. Older pre-stable folders are kept as `0.0.x` snapshots: `0.0.7` is the correctness milestone before the stable rename, `0.0.6` made `gpuSourcePort` the default, `0.0.5` kept `sourceExact` as the default, `0.0.2` contains the pair-grid stats-kernel improvement, and `0.0.0` is the baseline package.

Version guidance:

| Version | Advice | Performance note |
| --- | --- | --- |
| `1.1.1` | Current stable guarded concurrency line. | Same audio behavior as `1.1`, with configurable guarded slot locking to limit concurrent GPU normalize jobs. |
| `1.1` | Previous stable optimized exact GPU line. | Keeps CPU-output matching behavior and improves short 5.1 apply performance versus `1.0`; measured short benchmarks still remain slower than legacy CPU normalize. |
| `1.0` | Previous stable CPU-output matching line. | Same correctness target as `0.0.7`, with source/runtime paths resolved relative to the installed plugin folder instead of a hard-coded Tdarr path. Long-media performance remains slower than legacy CPU normalize. |
| `0.0.7` | CPU-output matching milestone before stable rename. | Validated for decoded parity against CPU-only `Normalize Audio` on the maintained matrix, but this correctness-first path is slower than CPU on long media. |
| `0.0.6` | Buggy pre-stable rollback only. | Bug: not same as CPU normalizer. `gpuSourcePort` default line was not performance-accepted against CPU `Normalize Audio`. |
| `0.0.5` | Buggy pre-stable rollback only. | Bug: not same as CPU normalizer. Faster on short/60s smokes, but decoded audio failed CPU `Normalize Audio` parity. |
| `0.0.2` | Buggy pre-stable rollback only. | Bug: not same as CPU normalizer. Faster on a 12s smoke, but decoded audio failed CPU `Normalize Audio` parity. |
| `0.0.0` | Buggy pre-stable rollback only. | Bug: not same as CPU normalizer. Original pre-stable baseline; no accepted CPU-normalizer performance matrix. |

Performance and audio comparisons should use Tdarr's normal CPU-only Community `Normalize Audio` plugin as the baseline. The expected target is CPU-normalizer output behavior with GPU acceleration, not a separate raw helper path.

Validated plugin behavior includes plugin load/defaults, no-audio skip, max-gain gate, PCM size guard, missing-runtime failure paths, all-audio normalization, and video/subtitle/data/attachment stream preservation.

<img width="1587" height="1443" alt="image" src="https://github.com/user-attachments/assets/9fc7119d-2caa-4bcf-b08b-f857e450f931" />
