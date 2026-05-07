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
- Keep improving long-media speed; the current release beats CPU on tested 10min/30min limiter-heavy cases, while short jobs can still be slower.

## Performance (i9 9900k @ 5ghz vs. Nvidia 1050 TI)

Latest release: `v1.1.9`.

`1.1.9` speeds up limiter-heavy `gpuSourcePort` jobs by parallelizing safe feedback-skip apply windows while keeping exact state updates and normal limiter/output rendering. It matches Tdarr's CPU-only `Normalize Audio` decoded output on the required matrix and is faster than CPU on the tested 10min and 30min limiter-heavy cases.

`Speed vs CPU` uses measured CPU/GPU wall time: above `1.0x` is faster than CPU, below `1.0x` is slower than CPU.

| Case | CPU `Normalize Audio` | GPU `1.1.9` | Speed vs CPU | Speed vs CPU Plugin |
| --- | ---: | ---: | ---: | --- |
| 30s | `10.1s` | `13.9s` | `0.724x` | ![GPU 28% slower](https://img.shields.io/badge/GPU-28%25%20slower-red)<br>![parity passed](https://img.shields.io/badge/parity-passed-brightgreen) |
| 60s | `16.7s` | `20.0s` | `0.834x` | ![GPU 17% slower](https://img.shields.io/badge/GPU-17%25%20slower-red)<br>![parity passed](https://img.shields.io/badge/parity-passed-brightgreen) |
| 10min | `169.8s` | `139.4s` | `1.218x` | ![GPU 22% faster](https://img.shields.io/badge/GPU-22%25%20faster-brightgreen)<br>![parity passed](https://img.shields.io/badge/parity-passed-brightgreen) |
| 30min | `544.0s` | `403.0s` | `1.350x` | ![GPU 35% faster](https://img.shields.io/badge/GPU-35%25%20faster-brightgreen)<br>![parity passed](https://img.shields.io/badge/parity-passed-brightgreen) |

Compared with the previous releases, `1.1.9` reduces measured GPU runtime. The time columns keep the measured wall times. The badge column shows only test-case speed changes versus the previous release, calculated as `previous time / current time - 1`; green is faster, red is slower, and grey is baseline or no published value.

| Version | 60s GPU Time | 10min GPU Time | 30min GPU Time | Exact Stats Time | Exact Apply Time | Speed Change vs Previous |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `1.1.9` | `20.0s` | `139.4s` | `403.0s` | `114.9s` | `112.8s` | ![30s +13%](https://img.shields.io/badge/30s-%2B13%25-brightgreen)<br>![60s +38%](https://img.shields.io/badge/60s-%2B38%25-brightgreen)<br>![10min +68%](https://img.shields.io/badge/10min-%2B68%25-brightgreen)<br>![30min +77%](https://img.shields.io/badge/30min-%2B77%25-brightgreen) |
| `1.1.8` | `27.5s` | `234.2s` | `712.1s` | `114.9s` | `363.3s` | ![30s +5%](https://img.shields.io/badge/30s-%2B5%25-brightgreen)<br>![60s +13%](https://img.shields.io/badge/60s-%2B13%25-brightgreen)<br>![10min +17%](https://img.shields.io/badge/10min-%2B17%25-brightgreen)<br>![30min +15%](https://img.shields.io/badge/30min-%2B15%25-brightgreen) |
| `1.1.7` | `31.2s` | `281.1s` | `841.4s` | `114.9s` | `515.2s` | ![30s +23%](https://img.shields.io/badge/30s-%2B23%25-brightgreen)<br>![60s +17%](https://img.shields.io/badge/60s-%2B17%25-brightgreen)<br>![10min no baseline](https://img.shields.io/badge/10min-no%20baseline-lightgrey)<br>![30min +15%](https://img.shields.io/badge/30min-%2B15%25-brightgreen) |
| `1.1.6` | `36.5s` | `no data` | `964.1s` | `114.8s` | `615.0s` | ![30s +21%](https://img.shields.io/badge/30s-%2B21%25-brightgreen)<br>![60s +37%](https://img.shields.io/badge/60s-%2B37%25-brightgreen)<br>![10min no data](https://img.shields.io/badge/10min-no%20data-lightgrey)<br>![30min +57%](https://img.shields.io/badge/30min-%2B57%25-brightgreen) |
| `1.1.5` | `50.1s` | `no data` | `1513.4s` | `114.9s` | `1158.5s` | ![30s no previous](https://img.shields.io/badge/30s-no%20previous-lightgrey)<br>![60s 0.4% slower](https://img.shields.io/badge/60s-0.4%25%20slower-red)<br>![10min no data](https://img.shields.io/badge/10min-no%20data-lightgrey)<br>![30min 0.4% slower](https://img.shields.io/badge/30min-0.4%25%20slower-red) |
| `1.1.4` | `49.9s` | `no data` | `1507.6s` | `114.8s` | `1158.3s` | ![30s no data](https://img.shields.io/badge/30s-no%20data-lightgrey)<br>![60s baseline](https://img.shields.io/badge/60s-baseline-lightgrey)<br>![10min no data](https://img.shields.io/badge/10min-no%20data-lightgrey)<br>![30min baseline](https://img.shields.io/badge/30min-baseline-lightgrey) |

Against `1.1.8`, `1.1.9` is about `38%` faster on the 60s case, `68%` faster on the 10min case, and `77%` faster on the 30min case by the `previous time / current time - 1` speed-change calculation. So `1.1.9` should be chosen for current speed and parity. It still matches CPU decoded output on the required matrix; 30s and 60s remain slower than CPU, while 10min and 30min are faster than CPU in this benchmark.

## Install

Download the latest GitHub release zip and extract it into your Tdarr plugins folder.

Keep the version folder. Do not flatten it.

Correct layout:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.1.9/
```

Tdarr loads:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.1.9/index.js
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
| `1.1.9` | Current release. Parallelizes safe feedback-skip apply windows while preserving exact state and decoded parity; required parity matrix passed. Faster than CPU on tested 10min/30min limiter-heavy media. |
| `1.1.8` | Skips safe output-feedback accumulation after the feedback threshold is active while preserving normal limiter/output rendering; required parity matrix passed. Still slower than CPU on long limiter-heavy media. |
| `1.1.7` | Slot-accumulated safe feedback, parallel unsafe feedback, smaller chunks, and asymmetric risk planning speed up limiter-heavy 5.1 jobs; required parity matrix passed. Still slower than CPU on long limiter-heavy media. |
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
