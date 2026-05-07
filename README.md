# GPU Normalize Audio for Tdarr

## TLDR

GPU Normalize Audio is a Tdarr FlowPlugin that tries to move FFmpeg `loudnorm`-style audio normalization onto the GPU while matching Tdarr's normal CPU-only `Normalize Audio` output.

What it does today:

- Normalizes every audio stream in a file, not only the first one.
- Keeps video, subtitles, chapters, metadata, attachments, and data streams.
- Uses CUDA for the loudness stats/apply path and streams decode/encode through FFmpeg.
- Avoids huge raw PCM bridge files for normal `gpuSourcePort` jobs.
- Keeps decoded audio parity as the top priority, even when that costs speed.

What we are trying to do:

- Match CPU `Normalize Audio` output first.
- Make the GPU path faster over time without cheating parity.
- Eventually beat CPU on long limiter-heavy media; it is not there yet.

## Performance (i9 9900k @ 5ghz vs. Nvidia 1050 TI)

Latest release: `v1.1.7`.

`1.1.7` speeds up limiter-heavy `gpuSourcePort` jobs with slot-accumulated safe feedback, parallel feedback for eligible unsafe chunks, smaller default GPU chunks, and asymmetric limiter-risk planning. Long limiter-heavy media is still slower than Tdarr's CPU-only `Normalize Audio` plugin, but it is faster than `1.1.6`.

`Speed vs CPU` uses the release-note value: above `1.0x` is faster than CPU, below `1.0x` is slower than CPU.

| Case | CPU `Normalize Audio` | GPU `1.1.7` | Speed vs CPU | Speed vs CPU Plugin |
| --- | ---: | ---: | ---: | --- |
| 30s | `10.1s` | `16.6s` | `0.608x` | ![GPU 39% slower](https://img.shields.io/badge/GPU-39%25%20slower-red)<br>![parity passed](https://img.shields.io/badge/parity-passed-brightgreen) |
| 60s | `16.7s` | `31.2s` | `0.536x` | ![GPU 46% slower](https://img.shields.io/badge/GPU-46%25%20slower-red)<br>![parity passed](https://img.shields.io/badge/parity-passed-brightgreen) |
| 10min | `no data` | `no data` | `no data` | ![10min no data](https://img.shields.io/badge/10min-no%20data-lightgrey) |
| 30min | `544.0s` | `841.4s` | `0.646x` | ![GPU 35% slower](https://img.shields.io/badge/GPU-35%25%20slower-red)<br>![parity passed](https://img.shields.io/badge/parity-passed-brightgreen) |

Compared with the previous releases, `1.1.7` reduces measured GPU runtime. The time columns keep the measured wall times. The badge column shows only test-case speed changes versus the previous release, calculated as `previous time / current time - 1`; green is faster, red is slower, and grey is baseline or no published value.

| Version | 60s GPU Time | 30min GPU Time | Exact Stats Time | Exact Apply Time | Speed Change vs Previous |
| --- | ---: | ---: | ---: | ---: | --- |
| `1.1.7` | `31.2s` | `841.4s` | `114.9s` | `515.2s` | ![30s +23%](https://img.shields.io/badge/30s-%2B23%25-brightgreen)<br>![60s +17%](https://img.shields.io/badge/60s-%2B17%25-brightgreen)<br>![10min no data](https://img.shields.io/badge/10min-no%20data-lightgrey)<br>![30min +15%](https://img.shields.io/badge/30min-%2B15%25-brightgreen) |
| `1.1.6` | `36.5s` | `964.1s` | `114.8s` | `615.0s` | ![30s +21%](https://img.shields.io/badge/30s-%2B21%25-brightgreen)<br>![60s +37%](https://img.shields.io/badge/60s-%2B37%25-brightgreen)<br>![10min no data](https://img.shields.io/badge/10min-no%20data-lightgrey)<br>![30min +57%](https://img.shields.io/badge/30min-%2B57%25-brightgreen) |
| `1.1.5` | `50.1s` | `1513.4s` | `114.9s` | `1158.5s` | ![30s no previous](https://img.shields.io/badge/30s-no%20previous-lightgrey)<br>![60s 0.4% slower](https://img.shields.io/badge/60s-0.4%25%20slower-red)<br>![10min no data](https://img.shields.io/badge/10min-no%20data-lightgrey)<br>![30min 0.4% slower](https://img.shields.io/badge/30min-0.4%25%20slower-red) |
| `1.1.4` | `49.9s` | `1507.6s` | `114.8s` | `1158.3s` | ![30s no data](https://img.shields.io/badge/30s-no%20data-lightgrey)<br>![60s baseline](https://img.shields.io/badge/60s-baseline-lightgrey)<br>![10min no data](https://img.shields.io/badge/10min-no%20data-lightgrey)<br>![30min baseline](https://img.shields.io/badge/30min-baseline-lightgrey) |

Against `1.1.6`, `1.1.7` is about `23%` faster on the 30s case, `17%` faster on the 60s case, and `15%` faster on the 30min case. So `1.1.7` should be chosen for current speed and parity. It still matches CPU decoded output on the required matrix, but it is not faster than CPU-only `Normalize Audio` yet.

## Install

Download the latest GitHub release zip and extract it into your Tdarr plugins folder.

Keep the version folder. Do not flatten it.

Correct layout:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.1.7/
```

Tdarr loads:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.1.7/index.js
```

## What To Use

Use the newest release unless you need to roll back.

Default mode is `gpuSourcePort`.

Recommended defaults:

- `channels=auto`
- `requireGpuWorker=true`
- `Max Concurrent Jobs=1`
- `Enable 2-Channel Track=true`

## Safety

- The plugin fails fast on CPU workers by default so GPU jobs do not accidentally run in CPU slots.
- `Max Concurrent Jobs` limits concurrent GPU normalize jobs with a lock so multiple files do not overload the GPU.
- `maxGain` can skip normalization when the required gain is too high.
- If no audio exists, the plugin skips and returns the original file.
- Rollback is simple because every release lives in its own version folder.

## Versions

| Version | Use |
| --- | --- |
| `1.1.7` | Current release. Slot-accumulated safe feedback, parallel unsafe feedback, smaller chunks, and asymmetric risk planning speed up limiter-heavy 5.1 jobs; required parity matrix passed. Still slower than CPU on long limiter-heavy media. |
| `1.1.6` | Segmented exact safe feedback speeds up limiter-heavy 5.1 jobs, required parity matrix passed. Still slower than CPU on long limiter-heavy media. |
| `1.1.5` | Modularized GPU runtime, required parity matrix passed. Performance is effectively unchanged from `1.1.4`; still slower than CPU on long limiter-heavy media. |
| `1.1.4` | Faster exact stats and limiter-active GPU path, required parity matrix passed. Still slower than CPU on long limiter-heavy media. |
| `1.1.3` | Faster limiter-active GPU path, required parity matrix passed. Still slower than CPU on long limiter-heavy media. |
| `1.1.2` | Streaming two-pass release. Avoids huge raw PCM bridge files and fixed long-case parity. |
| `1.1.1` | Added guarded GPU normalize concurrency. |
| `1.1` | Older optimized exact GPU line. |
| `1.0` | First stable CPU-output matching line. |
| `0.0.x` | Old pre-stable snapshots. Some are known not to match CPU normalizer output. Use only for rollback/debug. |

## Notes

This project is still performance work in progress. The quality target is CPU-normalizer decoded output behavior with GPU acceleration, not a separate audio result that only sounds close.

<img width="1587" height="1443" alt="image" src="https://github.com/user-attachments/assets/9fc7119d-2caa-4bcf-b08b-f857e450f931" />
