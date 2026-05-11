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
- Keep improving long-media speed; the current release beats CPU on tested long 5.1 jobs even when it also creates a normalized 2-channel fallback track.

## Performance (i9 9900k @ 5ghz vs. Nvidia 1050 TI)

Latest release: `v1.1.11`.

`1.1.11` keeps the streaming `gpuSourcePort` path and adds exact generated-stereo handling for files that need a 2-channel track. By default it normalizes every source audio stream and creates one normalized 2-channel fallback from the first audio stream when no 2-channel track exists. Disable `Only Add 2-Channel For First Audio` to create generated 2-channel fallback tracks for every non-stereo audio stream/language.

The table below uses a 5.1 source that has no existing stereo track. The GPU job writes both the normalized original 5.1 stream and the generated normalized 2-channel fallback, then both decoded streams are compared against Tdarr CPU `Normalize Audio` output. CPU time includes the CPU main normalize job plus the CPU normalized stereo fallback job.

`Speed vs CPU` uses measured CPU/GPU wall time: above `1.0x` is faster than CPU, below `1.0x` is slower than CPU.

| Case | CPU `Normalize Audio` + CPU 2ch fallback | GPU `1.1.11` combined job | Speed vs CPU | Result |
| --- | ---: | ---: | ---: | --- |
| 60min | `1369.8s` | `1237.2s` | `1.107x` | ![GPU 11% faster](https://img.shields.io/badge/GPU-11%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![2ch parity passed](https://img.shields.io/badge/2ch%20parity-passed-brightgreen) |
| 30min | `678.0s` | `634.9s` | `1.068x` | ![GPU 7% faster](https://img.shields.io/badge/GPU-7%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![2ch parity passed](https://img.shields.io/badge/2ch%20parity-passed-brightgreen) |
| 10min | `223.6s` | `217.2s` | `1.030x` | ![GPU 3% faster](https://img.shields.io/badge/GPU-3%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![2ch parity passed](https://img.shields.io/badge/2ch%20parity-passed-brightgreen) |
| 60s | `23.0s` | `30.8s` | `0.746x` | ![GPU 34% slower](https://img.shields.io/badge/GPU-34%25%20slower-red)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![2ch parity passed](https://img.shields.io/badge/2ch%20parity-passed-brightgreen) |
| 30s | `11.9s` | `21.1s` | `0.567x` | ![GPU 76% slower](https://img.shields.io/badge/GPU-76%25%20slower-red)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![2ch parity passed](https://img.shields.io/badge/2ch%20parity-passed-brightgreen) |

Short clips are still slower because fixed startup, decode/encode, and stream setup overhead dominate. Longer media is the intended target and is where the GPU path now catches and passes CPU on the tested 5.1 plus generated-2ch workload.

2-channel fallback behavior:

| Setting | Default | Behavior |
| --- | --- | --- |
| `Add 2-Channel Track` | `true` | Adds normalized generated stereo track(s) when needed. |
| `Only Add 2-Channel For First Audio` | `true` | Creates one generated stereo fallback from the first audio stream only. Disable it to create one for every non-stereo audio stream/language. |
| `2-Channel Track Order` | `end` | `end` keeps generated 2-channel tracks after the original normalized streams. Use `afterSource` to place each generated track after its source, or `first` to put generated tracks first. |

Compared with previous releases, `1.1.11` changes the default tested contract when `Add 2-Channel Track=true`: the GPU timing above includes the generated 2-channel fallback work, and parity is checked for both the original audio stream and the generated fallback. Older release rows below used the previous primary-stream speed table, so treat the timing comparison as release history rather than a strict same-workload benchmark.

| Version | 60s GPU Time | 10min GPU Time | 30min GPU Time | Exact Stats Time | Exact Apply Time | Speed Change vs Previous |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `1.1.11` | `30.8s` | `217.2s` | `634.9s` | `252.9s` | `162.8s` | ![5.1+2ch contract](https://img.shields.io/badge/contract-5.1%2B2ch-blue)<br>![30min exact parity](https://img.shields.io/badge/30min-parity%20passed-brightgreen)<br>![60min exact parity](https://img.shields.io/badge/60min-parity%20passed-brightgreen) |
| `1.1.10` | `15.2s` | `114.9s` | `334.0s` | `108.5s` | `97.9s` | ![30s +48%](https://img.shields.io/badge/30s-%2B48%25-brightgreen)<br>![60s +32%](https://img.shields.io/badge/60s-%2B32%25-brightgreen)<br>![10min +21%](https://img.shields.io/badge/10min-%2B21%25-brightgreen)<br>![30min +21%](https://img.shields.io/badge/30min-%2B21%25-brightgreen) |
| `1.1.9` | `20.0s` | `139.4s` | `403.0s` | `114.9s` | `112.8s` | ![30s +13%](https://img.shields.io/badge/30s-%2B13%25-brightgreen)<br>![60s +38%](https://img.shields.io/badge/60s-%2B38%25-brightgreen)<br>![10min +68%](https://img.shields.io/badge/10min-%2B68%25-brightgreen)<br>![30min +77%](https://img.shields.io/badge/30min-%2B77%25-brightgreen) |
| `1.1.8` | `27.5s` | `234.2s` | `712.1s` | `114.9s` | `363.3s` | ![30s +5%](https://img.shields.io/badge/30s-%2B5%25-brightgreen)<br>![60s +13%](https://img.shields.io/badge/60s-%2B13%25-brightgreen)<br>![10min +17%](https://img.shields.io/badge/10min-%2B17%25-brightgreen)<br>![30min +15%](https://img.shields.io/badge/30min-%2B15%25-brightgreen) |
| `1.1.7` | `31.2s` | `281.1s` | `841.4s` | `114.9s` | `515.2s` | ![30s +23%](https://img.shields.io/badge/30s-%2B23%25-brightgreen)<br>![60s +17%](https://img.shields.io/badge/60s-%2B17%25-brightgreen)<br>![10min no baseline](https://img.shields.io/badge/10min-no%20baseline-lightgrey)<br>![30min +15%](https://img.shields.io/badge/30min-%2B15%25-brightgreen) |
| `1.1.6` | `36.5s` | `no data` | `964.1s` | `114.8s` | `615.0s` | ![30s +21%](https://img.shields.io/badge/30s-%2B21%25-brightgreen)<br>![60s +37%](https://img.shields.io/badge/60s-%2B37%25-brightgreen)<br>![10min no data](https://img.shields.io/badge/10min-no%20data-lightgrey)<br>![30min +57%](https://img.shields.io/badge/30min-%2B57%25-brightgreen) |
| `1.1.5` | `50.1s` | `no data` | `1513.4s` | `114.9s` | `1158.5s` | ![30s no previous](https://img.shields.io/badge/30s-no%20previous-lightgrey)<br>![60s 0.4% slower](https://img.shields.io/badge/60s-0.4%25%20slower-red)<br>![10min no data](https://img.shields.io/badge/10min-no%20data-lightgrey)<br>![30min 0.4% slower](https://img.shields.io/badge/30min-0.4%25%20slower-red) |
| `1.1.4` | `49.9s` | `no data` | `1507.6s` | `114.8s` | `1158.3s` | ![30s no data](https://img.shields.io/badge/30s-no%20data-lightgrey)<br>![60s baseline](https://img.shields.io/badge/60s-baseline-lightgrey)<br>![10min no data](https://img.shields.io/badge/10min-no%20data-lightgrey)<br>![30min baseline](https://img.shields.io/badge/30min-baseline-lightgrey) |

Choose `1.1.11` for current parity and generated-stereo behavior. Use `1.1.10` only if you need the older release contract without the new generated-stereo scope/order controls.

## Install

Download the latest GitHub release zip and extract it into your Tdarr plugins folder.

Keep the version folder. Do not flatten it.

Correct layout:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.1.11/
```

Tdarr loads:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.1.11/index.js
```

## What To Use

Use the newest release unless you need to roll back.

Default mode is `gpuSourcePort`.

Recommended defaults:

- `Add 2-Channel Track=true`
- `Only Add 2-Channel For First Audio=true`
- `2-Channel Track Order=end`
- `Max Concurrent Jobs=1`
- `Audio Bitrate=192k`
- `Integrated Loudness I=-18.0`
- `Loudness Range LRA=7.0`
- `True Peak TP=-2.0`
- `Max Gain dB=15`
- `Debug Logging=false`

Internal defaults keep source channel counts (`channels=auto`) and fail fast on CPU workers (`requireGpuWorker=true`). Only `192k` audio bitrate is covered by the release parity/performance matrix.

## Safety

- The plugin fails fast on CPU workers by default so GPU jobs do not accidentally run in CPU slots.
- `Max Concurrent Jobs` limits concurrent GPU normalize jobs with a lock so multiple files do not overload the GPU.
- `maxGain` can skip normalization when the required gain is too high.
- `Debug Logging` is off by default so successful jobs keep logs concise while worker progress still updates.
- If no audio exists, the plugin skips and returns the original file.
- Rollback is simple because every release lives in its own version folder.

## Versions

| Version | Use |
| --- | --- |
| `1.1.11` | Current release. Keeps streaming `gpuSourcePort`, matches CPU decoded output for normalized 5.1 plus generated 2-channel fallback on tested long media, and adds controls for first-audio-only versus all-language 2-channel fallback generation and generated-track order. |
| `1.1.10` | Uses smaller streaming chunks, stats decode prefetch, and safe unsafe-output-feedback skipping after threshold lock; required parity matrix passed. Faster than CPU on all tested required limiter-heavy primary-stream cases. |
| `1.1.9` | Parallelizes safe feedback-skip apply windows while preserving exact state and decoded parity; required parity matrix passed. Faster than CPU on tested 10min/30min limiter-heavy media. |
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
