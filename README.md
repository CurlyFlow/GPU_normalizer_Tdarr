# GPU Normalize Audio for Tdarr

*USE AT YOUR OWN RISK* 

*THIS IS WIP*

*IT MIGHT BURN YOUR HOUSE* ;-) 

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

## Plugin UI

<img width="1305" height="661" alt="image" src="https://github.com/user-attachments/assets/4ff69be3-772a-4554-beef-93cda9dc7c06" />


## Performance (i9 9900k @ 5ghz vs. Nvidia 1050 TI)

Latest release: `v1.2.1`.

`1.2.1` keeps the streaming `gpuSourcePort` path, adds `Normalize ONLY Languages`, improves default job logs, removes stale hidden flow inputs, and preserves exact decoded parity against Tdarr CPU `Normalize Audio`. By default the release UI prefers English for both `Track Order` and `Normalize ONLY Languages` (`eng,en`). Clear `Normalize ONLY Languages` or enter `all` to normalize every audio stream. If the selected languages match no streams, the plugin passes the file through unchanged without taking the GPU lock or muxing.

The table below uses a 5.1 source that has no existing stereo track. The GPU job writes both the normalized original 5.1 stream and the generated normalized 2-channel fallback, then both decoded streams are compared against Tdarr CPU `Normalize Audio` output. `SRC_CPU` time is split the same way: the original CPU `Normalize Audio` job for the 5.1 stream, plus a CPU `Normalize Audio` reference for the generated 2-channel source.

`Speed vs CPU` uses measured SRC_CPU/GPU wall time: above `1.0x` is faster than CPU, below `1.0x` is slower than CPU.

60min TLDR: original 5.1 `2.279x` faster (`1027.3s` CPU vs `450.7s` GPU), generated 2ch `0.715x` slower (`291.2s` CPU vs `407.0s` GPU), combined job `1.530x` faster (`1318.5s` CPU vs `861.9s` GPU), parity pass for both decoded streams.

### 60min

| Workload | CPU reference | GPU `1.2.1` | Speed vs CPU | Result |
| --- | ---: | ---: | ---: | --- |
| Original 5.1 | `1027.3s` | `450.7s` | `2.279x` | ![GPU 128% faster](https://img.shields.io/badge/GPU-128%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen) |
| Generated 2ch | `291.2s` | `407.0s` | `0.715x` | ![GPU 40% slower](https://img.shields.io/badge/GPU-40%25%20slower-red)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| Combined | `1318.5s` | `861.9s` | `1.530x` | ![GPU 53% faster](https://img.shields.io/badge/GPU-53%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |

### 30min

| Workload | CPU reference | GPU `1.2.1` | Speed vs CPU | Result |
| --- | ---: | ---: | ---: | --- |
| Original 5.1 | `540.3s` | `229.9s` | `2.350x` | ![GPU 135% faster](https://img.shields.io/badge/GPU-135%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen) |
| Generated 2ch | `155.5s` | `206.7s` | `0.753x` | ![GPU 33% slower](https://img.shields.io/badge/GPU-33%25%20slower-red)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| Combined | `695.8s` | `438.5s` | `1.587x` | ![GPU 59% faster](https://img.shields.io/badge/GPU-59%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |

### 10min

| Workload | CPU reference | GPU `1.2.1` | Speed vs CPU | Result |
| --- | ---: | ---: | ---: | --- |
| Original 5.1 | `168.6s` | `78.4s` | `2.149x` | ![GPU 115% faster](https://img.shields.io/badge/GPU-115%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen) |
| Generated 2ch | `49.9s` | `71.8s` | `0.696x` | ![GPU 44% slower](https://img.shields.io/badge/GPU-44%25%20slower-red)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| Combined | `218.5s` | `150.9s` | `1.448x` | ![GPU 45% faster](https://img.shields.io/badge/GPU-45%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |

### 60s

| Workload | CPU reference | GPU `1.2.1` | Speed vs CPU | Result |
| --- | ---: | ---: | ---: | --- |
| Original 5.1 | `18.3s` | `9.6s` | `1.912x` | ![GPU 91% faster](https://img.shields.io/badge/GPU-91%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen) |
| Generated 2ch | `5.0s` | `11.0s` | `0.452x` | ![GPU 121% slower](https://img.shields.io/badge/GPU-121%25%20slower-red)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| Combined | `23.3s` | `20.8s` | `1.123x` | ![GPU 12% faster](https://img.shields.io/badge/GPU-12%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |

### 30s

| Workload | CPU reference | GPU `1.2.1` | Speed vs CPU | Result |
| --- | ---: | ---: | ---: | --- |
| Original 5.1 | `9.8s` | `6.6s` | `1.496x` | ![GPU 50% faster](https://img.shields.io/badge/GPU-50%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen) |
| Generated 2ch | `2.6s` | `6.4s` | `0.405x` | ![GPU 147% slower](https://img.shields.io/badge/GPU-147%25%20slower-red)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| Combined | `12.4s` | `13.1s` | `0.948x` | ![GPU 5% slower](https://img.shields.io/badge/GPU-5%25%20slower-red)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |

Short clips are still slower because fixed startup, decode/encode, and stream setup overhead dominate. Longer media is the intended target and is where the GPU path now catches and passes CPU on the tested 5.1 plus generated-2ch workload.

Codec smoke coverage for `1.2.1` also passed exact decoded parity for AAC stereo, MP3 stereo, AC3 5.1, E-AC-3 5.1, DTS 5.1, and a multi-audio sample. The multi-audio smoke also verifies language-scope behavior: blank means all languages, omitted means release default English, no-match copies all audio unchanged, and German-only scopes select only German audio.

2-channel fallback behavior:

| Setting | Default | Behavior |
| --- | --- | --- |
| `Add Generated 2-Channel Track` | `true` | Adds normalized generated stereo track(s) according to the selected 2-channel scope. |
| `Track Order` | `eng,en` | Comma-separated language priority used before choosing the generated 2-channel source. The default prefers English, while unlisted languages keep source order after listed languages. This uses source metadata and cannot fix missing or wrong language tags. |
| `Normalize ONLY Languages` | `eng,en` | Comma-separated language filter for streams to normalize. Clear it or enter `all` to normalize every audio stream. If no selected language exists, all audio streams are copied unchanged. |
| `Only Generate 2-Channel For First Language` | `true` | Ensures the first `Track Order` language has stereo. If that language lacks stereo, creates one generated track from the best same-language source, preferring 5.1/6-channel over 7.1/8-channel. Disable it to create one for every non-stereo audio stream/language. |

Compared with releases before `1.1.11`, the default tested contract when `Add Generated 2-Channel Track=true` includes generated 2-channel fallback work, and parity is checked for both the original audio stream and the generated fallback. Older release rows below used the previous primary-stream speed table, so treat the timing comparison as release history rather than a strict same-workload benchmark.

| Version | 60s GPU Time | 10min GPU Time | 30min GPU Time | Exact Stats Time | Exact Apply Time | Speed Change vs Previous |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `1.2.1` | `20.8s` | `150.9s` | `438.5s` | `244.3s` | `131.9s` | ![60min GPU 53% faster](https://img.shields.io/badge/60min%20GPU-53%25%20faster-brightgreen)<br>![30min GPU 59% faster](https://img.shields.io/badge/30min%20GPU-59%25%20faster-brightgreen)<br>![10min GPU 45% faster](https://img.shields.io/badge/10min%20GPU-45%25%20faster-brightgreen)<br>![language filter added](https://img.shields.io/badge/language%20filter-added-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.2.0` | `21.2s` | `155.7s` | `452.3s` | `261.5s` | `138.1s` | ![60min GPU 47% faster](https://img.shields.io/badge/60min%20GPU-47%25%20faster-brightgreen)<br>![30min GPU 54% faster](https://img.shields.io/badge/30min%20GPU-54%25%20faster-brightgreen)<br>![10min GPU 40% faster](https://img.shields.io/badge/10min%20GPU-40%25%20faster-brightgreen)<br>![fallback scope fixed](https://img.shields.io/badge/fallback%20scope-fixed-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.1.13` | `21.5s` | `155.3s` | `456.8s` | `262.2s` | `138.7s` | ![10min GPU 27% faster](https://img.shields.io/badge/10min%20GPU-27%25%20faster-brightgreen)<br>![30min GPU 24% faster](https://img.shields.io/badge/30min%20GPU-24%25%20faster-brightgreen)<br>![60min GPU 23% faster](https://img.shields.io/badge/60min%20GPU-23%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.1.12` | `29.0s` | `196.5s` | `568.4s` | `222.0s` | `169.5s` | ![10min GPU 11% faster](https://img.shields.io/badge/10min%20GPU-11%25%20faster-brightgreen)<br>![30min GPU 12% faster](https://img.shields.io/badge/30min%20GPU-12%25%20faster-brightgreen)<br>![60min GPU 13% faster](https://img.shields.io/badge/60min%20GPU-13%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.1.11` | `30.8s` | `217.2s` | `634.9s` | `252.9s` | `162.8s` | ![30min GPU 7% faster](https://img.shields.io/badge/30min%20GPU-7%25%20faster-brightgreen)<br>![60min GPU 11% faster](https://img.shields.io/badge/60min%20GPU-11%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.1.10` | `15.2s` | `114.9s` | `334.0s` | `108.5s` | `97.9s` | ![30s +48%](https://img.shields.io/badge/30s-%2B48%25-brightgreen)<br>![60s +32%](https://img.shields.io/badge/60s-%2B32%25-brightgreen)<br>![10min +21%](https://img.shields.io/badge/10min-%2B21%25-brightgreen)<br>![30min +21%](https://img.shields.io/badge/30min-%2B21%25-brightgreen) |
| `1.1.9` | `20.0s` | `139.4s` | `403.0s` | `114.9s` | `112.8s` | ![30s +13%](https://img.shields.io/badge/30s-%2B13%25-brightgreen)<br>![60s +38%](https://img.shields.io/badge/60s-%2B38%25-brightgreen)<br>![10min +68%](https://img.shields.io/badge/10min-%2B68%25-brightgreen)<br>![30min +77%](https://img.shields.io/badge/30min-%2B77%25-brightgreen) |
| `1.1.8` | `27.5s` | `234.2s` | `712.1s` | `114.9s` | `363.3s` | ![30s +5%](https://img.shields.io/badge/30s-%2B5%25-brightgreen)<br>![60s +13%](https://img.shields.io/badge/60s-%2B13%25-brightgreen)<br>![10min +17%](https://img.shields.io/badge/10min-%2B17%25-brightgreen)<br>![30min +15%](https://img.shields.io/badge/30min-%2B15%25-brightgreen) |
| `1.1.7` | `31.2s` | `281.1s` | `841.4s` | `114.9s` | `515.2s` | ![30s +23%](https://img.shields.io/badge/30s-%2B23%25-brightgreen)<br>![60s +17%](https://img.shields.io/badge/60s-%2B17%25-brightgreen)<br>![10min no baseline](https://img.shields.io/badge/10min-no%20baseline-lightgrey)<br>![30min +15%](https://img.shields.io/badge/30min-%2B15%25-brightgreen) |
| `1.1.6` | `36.5s` | `no data` | `964.1s` | `114.8s` | `615.0s` | ![30s +21%](https://img.shields.io/badge/30s-%2B21%25-brightgreen)<br>![60s +37%](https://img.shields.io/badge/60s-%2B37%25-brightgreen)<br>![10min no data](https://img.shields.io/badge/10min-no%20data-lightgrey)<br>![30min +57%](https://img.shields.io/badge/30min-%2B57%25-brightgreen) |
| `1.1.5` | `50.1s` | `no data` | `1513.4s` | `114.9s` | `1158.5s` | ![30s no previous](https://img.shields.io/badge/30s-no%20previous-lightgrey)<br>![60s 0.4% slower](https://img.shields.io/badge/60s-0.4%25%20slower-red)<br>![10min no data](https://img.shields.io/badge/10min-no%20data-lightgrey)<br>![30min 0.4% slower](https://img.shields.io/badge/30min-0.4%25%20slower-red) |
| `1.1.4` | `49.9s` | `no data` | `1507.6s` | `114.8s` | `1158.3s` | ![30s no data](https://img.shields.io/badge/30s-no%20data-lightgrey)<br>![60s baseline](https://img.shields.io/badge/60s-baseline-lightgrey)<br>![10min no data](https://img.shields.io/badge/10min-no%20data-lightgrey)<br>![30min baseline](https://img.shields.io/badge/30min-baseline-lightgrey) |

Choose `1.2.1` for current parity, language-only normalization controls, readable default job logs, deploy cleanup, and corrected generated-stereo first-language behavior. Use `1.2.0` only if you need the previous no-language-filter UI.

## Install

Download the latest GitHub release zip and extract it into your Tdarr plugins folder.

Keep the version folder. Do not flatten it.

Correct layout:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.2.1/
```

Tdarr loads:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.2.1/index.js
```

Defaults:

- `Add Generated 2-Channel Track=true`
- `Track Order=eng,en`
- `Normalize ONLY Languages=eng,en` (clear it or use `all` to normalize every language)
- `Only Generate 2-Channel For First Language=true`
- `Max Concurrent Jobs=1`
- `Audio Bitrate=192k`
- `Integrated Loudness I=-18.0`
- `Loudness Range LRA=7.0`
- `True Peak TP=-2.0`
- `Max Gain dB=15`
- `Debug Logging=false`


## Versions

| Version | Use |
| --- | --- |
| `1.2.1` | Current release. Adds language-only normalization, no-match pass-through, cleaner default logs, deploy cleanup, and matches CPU decoded output for normalized 5.1 plus generated 2-channel fallback on the required matrix. |
| `1.2.0` | Previous release. Fixes generated-stereo first-language scope, keeps streaming `gpuSourcePort`, and matches CPU decoded output for normalized 5.1 plus generated 2-channel fallback on the required matrix. |
| `1.1.13` | Previous release. Speeds up long generated-stereo fallback jobs again, keeps streaming `gpuSourcePort`, and matches CPU decoded output for normalized 5.1 plus generated 2-channel fallback on the required matrix. |
| `1.1.12` | Older release. Speeds up long generated-stereo fallback jobs, keeps streaming `gpuSourcePort`, and matches CPU decoded output for normalized 5.1 plus generated 2-channel fallback on the required matrix. |
| `1.1.11` | Keeps streaming `gpuSourcePort`, matches CPU decoded output for normalized 5.1 plus generated 2-channel fallback on tested long media, and adds language-priority controls for first-language versus all-language 2-channel fallback generation. |
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
