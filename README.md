# GPU Normalize Audio for Tdarr

## TLDR

GPU Normalize Audio is a Tdarr FlowPlugin that tries to move FFmpeg `loudnorm`-style audio normalization onto the GPU while matching Tdarr's normal CPU-only `Normalize Audio` output.

What it does today:

- Normalizes every audio stream in a file, not only the first one.
- Keeps video, subtitles, chapters, metadata, attachments, and data streams.
- Uses CUDA for the loudness stats/apply path and streams decode/encode through FFmpeg.
- Avoids huge raw PCM bridge files for normal `gpuSourcePort` jobs.
- Keeps decoded audio parity as the top priority, even when that costs speed.
- Release smoke testing covers multiple input codec/layout cases, including AAC stereo, MP3 stereo, AC3 5.1, E-AC-3 5.1, DTS 5.1, and multi-audio inputs.

What we are trying to do:

- Match CPU `Normalize Audio` output first.
- Make the GPU path faster over time without cheating parity.
- Keep improving long-media speed; the current release beats CPU on tested long combined jobs because the original 5.1 normalization is faster, while generated 2-channel fallback work is still slower by itself.

## Performance (i9 9900k @ 5ghz vs. Nvidia 1050 TI)

Latest release: `v1.1.11`.

`1.1.11` keeps the streaming `gpuSourcePort` path and adds exact generated-stereo handling for files that need a 2-channel track. By default it normalizes every source audio stream, sorts audio streams by `Track Order` language priority (`eng,en`), and creates one normalized 2-channel fallback from the first matching non-stereo language when no 2-channel track exists. Disable `Only Add 2-Channel For First Language` to create generated 2-channel fallback tracks for every non-stereo audio stream/language.

The table below uses a 5.1 source that has no existing stereo track. The GPU job writes both the normalized original 5.1 stream and the generated normalized 2-channel fallback, then both decoded streams are compared against Tdarr CPU `Normalize Audio` output. CPU time is split the same way: the original CPU `Normalize Audio` job for the 5.1 stream, plus a CPU `Normalize Audio` reference for the generated 2-channel source.

`Speed vs CPU` uses measured CPU/GPU wall time: above `1.0x` is faster than CPU, below `1.0x` is slower than CPU.

60min TLDR: original 5.1 `1.760x` faster (`1072.6s` CPU vs `609.3s` GPU), generated 2ch `0.478x` slower (`297.2s` CPU vs `621.7s` GPU), combined job `1.107x` faster (`1369.8s` CPU vs `1237.2s` GPU), parity pass for both decoded streams.

| Case | Workload | CPU reference | GPU `1.1.11` | Speed vs CPU | Result |
| --- | --- | ---: | ---: | ---: | --- |
| 60min | Original 5.1 | `1072.6s` | `609.3s` | `1.760x` | ![GPU 76% faster](https://img.shields.io/badge/GPU-76%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen) |
| 60min | Generated 2ch | `297.2s` | `621.7s` | `0.478x` | ![GPU 109% slower](https://img.shields.io/badge/GPU-109%25%20slower-red)<br>![2ch parity passed](https://img.shields.io/badge/2ch%20parity-passed-brightgreen) |
| 60min | Combined | `1369.8s` | `1237.2s` | `1.107x` | ![GPU 11% faster](https://img.shields.io/badge/GPU-11%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![2ch parity passed](https://img.shields.io/badge/2ch%20parity-passed-brightgreen) |
| 30min | Original 5.1 | `529.0s` | `310.6s` | `1.703x` | ![GPU 70% faster](https://img.shields.io/badge/GPU-70%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen) |
| 30min | Generated 2ch | `149.1s` | `322.2s` | `0.463x` | ![GPU 116% slower](https://img.shields.io/badge/GPU-116%25%20slower-red)<br>![2ch parity passed](https://img.shields.io/badge/2ch%20parity-passed-brightgreen) |
| 30min | Combined | `678.0s` | `634.9s` | `1.068x` | ![GPU 7% faster](https://img.shields.io/badge/GPU-7%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![2ch parity passed](https://img.shields.io/badge/2ch%20parity-passed-brightgreen) |
| 10min | Original 5.1 | `175.2s` | `105.2s` | `1.665x` | ![GPU 67% faster](https://img.shields.io/badge/GPU-67%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen) |
| 10min | Generated 2ch | `48.4s` | `111.2s` | `0.435x` | ![GPU 130% slower](https://img.shields.io/badge/GPU-130%25%20slower-red)<br>![2ch parity passed](https://img.shields.io/badge/2ch%20parity-passed-brightgreen) |
| 10min | Combined | `223.6s` | `217.2s` | `1.030x` | ![GPU 3% faster](https://img.shields.io/badge/GPU-3%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![2ch parity passed](https://img.shields.io/badge/2ch%20parity-passed-brightgreen) |
| 60s | Original 5.1 | `18.2s` | `13.7s` | `1.326x` | ![GPU 33% faster](https://img.shields.io/badge/GPU-33%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen) |
| 60s | Generated 2ch | `4.8s` | `17.0s` | `0.285x` | ![GPU 251% slower](https://img.shields.io/badge/GPU-251%25%20slower-red)<br>![2ch parity passed](https://img.shields.io/badge/2ch%20parity-passed-brightgreen) |
| 60s | Combined | `23.0s` | `30.8s` | `0.746x` | ![GPU 34% slower](https://img.shields.io/badge/GPU-34%25%20slower-red)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![2ch parity passed](https://img.shields.io/badge/2ch%20parity-passed-brightgreen) |
| 30s | Original 5.1 | `9.4s` | `8.6s` | `1.092x` | ![GPU 9% faster](https://img.shields.io/badge/GPU-9%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen) |
| 30s | Generated 2ch | `2.6s` | `12.4s` | `0.208x` | ![GPU 381% slower](https://img.shields.io/badge/GPU-381%25%20slower-red)<br>![2ch parity passed](https://img.shields.io/badge/2ch%20parity-passed-brightgreen) |
| 30s | Combined | `11.9s` | `21.1s` | `0.567x` | ![GPU 76% slower](https://img.shields.io/badge/GPU-76%25%20slower-red)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![2ch parity passed](https://img.shields.io/badge/2ch%20parity-passed-brightgreen) |

Short clips are still slower because fixed startup, decode/encode, and stream setup overhead dominate. Longer media is the intended target and is where the GPU path now catches and passes CPU on the tested 5.1 plus generated-2ch workload.

Codec smoke coverage for `1.1.11` also passed exact decoded parity for AAC stereo, MP3 stereo, AC3 5.1, E-AC-3 5.1, DTS 5.1, and a multi-audio sample. The multi-audio smoke compares each GPU-normalized source stream against Tdarr CPU `Normalize Audio` run on an isolated source for that same stream, matching this plugin's per-stream normalization behavior.

2-channel fallback behavior:

| Setting | Default | Behavior |
| --- | --- | --- |
| `Add 2-Channel Track` | `true` | Adds normalized generated stereo track(s) when needed. |
| `Track Order` | `eng,en` | Comma-separated language priority used before choosing the generated 2-channel source. The default prefers English, while unlisted languages keep source order after listed languages. |
| `Only Add 2-Channel For First Language` | `true` | Creates one generated stereo fallback from the first non-stereo stream after `Track Order` sorting. Disable it to create one for every non-stereo audio stream/language. |

Compared with previous releases, `1.1.11` changes the default tested contract when `Add 2-Channel Track=true`: the GPU timing above includes the generated 2-channel fallback work, and parity is checked for both the original audio stream and the generated fallback. Older release rows below used the previous primary-stream speed table, so treat the timing comparison as release history rather than a strict same-workload benchmark.

| Version | 60s GPU Time | 10min GPU Time | 30min GPU Time | Exact Stats Time | Exact Apply Time | Speed Change vs Previous |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `1.1.11` | `30.8s` | `217.2s` | `634.9s` | `252.9s` | `162.8s` | ![30min GPU 7% faster](https://img.shields.io/badge/30min%20GPU-7%25%20faster-brightgreen)<br>![60min GPU 11% faster](https://img.shields.io/badge/60min%20GPU-11%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.1.10` | `15.2s` | `114.9s` | `334.0s` | `108.5s` | `97.9s` | ![30s +48%](https://img.shields.io/badge/30s-%2B48%25-brightgreen)<br>![60s +32%](https://img.shields.io/badge/60s-%2B32%25-brightgreen)<br>![10min +21%](https://img.shields.io/badge/10min-%2B21%25-brightgreen)<br>![30min +21%](https://img.shields.io/badge/30min-%2B21%25-brightgreen) |
| `1.1.9` | `20.0s` | `139.4s` | `403.0s` | `114.9s` | `112.8s` | ![30s +13%](https://img.shields.io/badge/30s-%2B13%25-brightgreen)<br>![60s +38%](https://img.shields.io/badge/60s-%2B38%25-brightgreen)<br>![10min +68%](https://img.shields.io/badge/10min-%2B68%25-brightgreen)<br>![30min +77%](https://img.shields.io/badge/30min-%2B77%25-brightgreen) |
| `1.1.8` | `27.5s` | `234.2s` | `712.1s` | `114.9s` | `363.3s` | ![30s +5%](https://img.shields.io/badge/30s-%2B5%25-brightgreen)<br>![60s +13%](https://img.shields.io/badge/60s-%2B13%25-brightgreen)<br>![10min +17%](https://img.shields.io/badge/10min-%2B17%25-brightgreen)<br>![30min +15%](https://img.shields.io/badge/30min-%2B15%25-brightgreen) |
| `1.1.7` | `31.2s` | `281.1s` | `841.4s` | `114.9s` | `515.2s` | ![30s +23%](https://img.shields.io/badge/30s-%2B23%25-brightgreen)<br>![60s +17%](https://img.shields.io/badge/60s-%2B17%25-brightgreen)<br>![10min no baseline](https://img.shields.io/badge/10min-no%20baseline-lightgrey)<br>![30min +15%](https://img.shields.io/badge/30min-%2B15%25-brightgreen) |
| `1.1.6` | `36.5s` | `no data` | `964.1s` | `114.8s` | `615.0s` | ![30s +21%](https://img.shields.io/badge/30s-%2B21%25-brightgreen)<br>![60s +37%](https://img.shields.io/badge/60s-%2B37%25-brightgreen)<br>![10min no data](https://img.shields.io/badge/10min-no%20data-lightgrey)<br>![30min +57%](https://img.shields.io/badge/30min-%2B57%25-brightgreen) |
| `1.1.5` | `50.1s` | `no data` | `1513.4s` | `114.9s` | `1158.5s` | ![30s no previous](https://img.shields.io/badge/30s-no%20previous-lightgrey)<br>![60s 0.4% slower](https://img.shields.io/badge/60s-0.4%25%20slower-red)<br>![10min no data](https://img.shields.io/badge/10min-no%20data-lightgrey)<br>![30min 0.4% slower](https://img.shields.io/badge/30min-0.4%25%20slower-red) |
| `1.1.4` | `49.9s` | `no data` | `1507.6s` | `114.8s` | `1158.3s` | ![30s no data](https://img.shields.io/badge/30s-no%20data-lightgrey)<br>![60s baseline](https://img.shields.io/badge/60s-baseline-lightgrey)<br>![10min no data](https://img.shields.io/badge/10min-no%20data-lightgrey)<br>![30min baseline](https://img.shields.io/badge/30min-baseline-lightgrey) |

Choose `1.1.11` for current parity and generated-stereo behavior. Use `1.1.10` only if you need the older release contract without the new generated-stereo language-priority controls.

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
- `Track Order=eng,en`
- `Only Add 2-Channel For First Language=true`
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
| `1.1.11` | Current release. Keeps streaming `gpuSourcePort`, matches CPU decoded output for normalized 5.1 plus generated 2-channel fallback on tested long media, and adds language-priority controls for first-language versus all-language 2-channel fallback generation. |
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
