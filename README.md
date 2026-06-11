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
- Keep improving long-media speed; the current release beats CPU on tested long combined 5.1 plus generated 2-channel fallback jobs.

## Plugin UI

<img width="1305" height="661" alt="image" src="https://github.com/user-attachments/assets/4ff69be3-772a-4554-beef-93cda9dc7c06" />

## Install

Download the latest GitHub release zip and extract it into your Tdarr plugins folder.

Keep the version folder. Do not flatten it.

Correct layout:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.2.8/
```

Tdarr loads:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.2.8/index.js
```

Tdarr Docker CUDA library path hint:

```bash
-e LD_LIBRARY_PATH=/usr/lib64:/usr/lib/x86_64-linux-gnu
```

Set this on the Tdarr Docker container if CUDA loading fails because the container resolves the wrong `libcuda.so.1` first, for example with `libcuda.so.1: file too short`.

Defaults:

- `Add Generated 2-Channel Track=true`
- `Track Order=eng,en`
- `Normalize ONLY Languages=eng,en` (clear it or use `all` to normalize every language)
- `Remove Other Languages=true`
- `Fallback To Undetected Audio=true`
- `Only Generate 2-Channel For First Language=true`
- `Max Concurrent Jobs=1`
- `Audio Bitrate=192k`
- `Integrated Loudness I=-18.0`
- `Loudness Range LRA=7.0`
- `True Peak TP=-2.0`
- `Max Gain dB=15`
- `Debug Logging=false`

## Performance (i9 9900k @ 5ghz vs. Nvidia 1050 TI)

Latest release: `v1.2.8`.

`1.2.8` keeps the streaming `gpuSourcePort` path, promotes the accepted long-media optimization stack, fixes a post-success generated-stereo fallback teardown crash, and preserves exact decoded parity against Tdarr CPU `Normalize Audio` on the validated matrix. By default the release UI prefers English for both `Track Order` and `Normalize ONLY Languages` (`eng,en`), `Remove Other Languages` is on, and `Fallback To Undetected Audio` is on. Clear `Normalize ONLY Languages` or enter `all` to normalize every audio stream. If selected languages match no streams while removal is on, undetected audio is copied unchanged when present; if no desired or undetected audio would remain, the job fails instead of producing a no-audio output.

The table below uses a 5.1 source that has no existing stereo track. The GPU job writes both the normalized original 5.1 stream and the generated normalized 2-channel fallback, then both decoded streams are compared against Tdarr CPU `Normalize Audio` output. `SRC_CPU` time is split the same way: the original CPU `Normalize Audio` job for the 5.1 stream, plus a CPU `Normalize Audio` reference for the generated 2-channel source.

`Speed vs CPU` uses measured SRC_CPU/GPU wall time: above `1.0x` is faster than CPU, below `1.0x` is slower than CPU.

60min TLDR: original 5.1 `2.842x` faster (`1123.3s` CPU vs `395.3s` GPU), generated 2ch `1.068x` faster (`283.4s` CPU vs `265.4s` GPU), combined job `3.522x` faster (`1406.7s` CPU vs `399.4s` GPU), parity pass for both decoded streams.

30min TLDR: original 5.1 `2.633x` faster (`528.6s` CPU vs `200.8s` GPU), generated 2ch `1.065x` faster (`140.4s` CPU vs `131.9s` GPU), combined job `3.298x` faster (`669.0s` CPU vs `202.8s` GPU), parity pass for both decoded streams. `1.2.8` is a long-media combined-wall speed and stability release over `1.2.7`.

### 60min

| Workload | CPU reference | GPU `1.2.8` | Speed vs CPU | Result |
| --- | ---: | ---: | ---: | --- |
| Original 5.1 | `1123.3s` | `395.3s` | `2.842x` | ![GPU 184% faster](https://img.shields.io/badge/GPU-184%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen) |
| Generated 2ch | `283.4s` | `265.4s` | `1.068x` | ![GPU 7% faster](https://img.shields.io/badge/GPU-7%25%20faster-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| Combined | `1406.7s` | `399.4s` | `3.522x` | ![GPU 252% faster](https://img.shields.io/badge/GPU-252%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |

### 30min

| Workload | CPU reference | GPU `1.2.8` | Speed vs CPU | Result |
| --- | ---: | ---: | ---: | --- |
| Original 5.1 | `528.6s` | `200.8s` | `2.633x` | ![GPU 163% faster](https://img.shields.io/badge/GPU-163%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen) |
| Generated 2ch | `140.4s` | `131.9s` | `1.065x` | ![GPU 6% faster](https://img.shields.io/badge/GPU-6%25%20faster-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| Combined | `669.0s` | `202.8s` | `3.298x` | ![GPU 230% faster](https://img.shields.io/badge/GPU-230%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |

### 10min

| Workload | CPU reference | GPU `1.2.8` | Speed vs CPU | Result |
| --- | ---: | ---: | ---: | --- |
| Original 5.1 | `168.6s` | `70.4s` | `2.395x` | ![GPU 140% faster](https://img.shields.io/badge/GPU-140%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen) |
| Generated 2ch | `49.9s` | `44.4s` | `1.124x` | ![GPU 12% faster](https://img.shields.io/badge/GPU-12%25%20faster-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| Combined | `218.5s` | `71.1s` | `3.073x` | ![GPU 207% faster](https://img.shields.io/badge/GPU-207%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |

Short smoke clips are used only for parity checks and are intentionally excluded from the main README performance tables. Longer media is the intended target and is where the GPU path now catches and passes CPU on the tested 5.1 plus generated-2ch workload.

Codec smoke coverage for `1.2.8` covers AAC stereo, MP3 stereo, AC3 5.1, E-AC-3 5.1, DTS 5.1, and a multi-audio sample. The multi-audio smoke also verifies language-scope behavior: blank means all languages, omitted means release default English with other languages removed, `Remove Other Languages=false` copies non-selected audio unchanged, and no language match fails safely when no desired or undetected audio would remain.

2-channel fallback behavior:

| Setting | Default | Behavior |
| --- | --- | --- |
| `Add Generated 2-Channel Track` | `true` | Adds normalized generated stereo track(s) according to the selected 2-channel scope. |
| `Track Order` | `eng,en` | Comma-separated language priority used before choosing the generated 2-channel source. The default prefers English, while unlisted languages keep source order after listed languages. This uses source metadata and cannot fix missing or wrong language tags. |
| `Normalize ONLY Languages` | `eng,en` | Comma-separated language filter for streams to normalize. Clear it or enter `all` to normalize every audio stream. |
| `Remove Other Languages` | `true` | When `Normalize ONLY Languages` is a real language list, deletes audio streams outside that list. Disable it to copy other languages unchanged. |
| `Fallback To Undetected Audio` | `true` | If selected languages do not exist and removal is on, keep undetected audio streams unchanged when present. If no desired or undetected audio would remain, fail the job instead of outputting a no-audio file. |
| `Only Generate 2-Channel For First Language` | `true` | Ensures the first `Track Order` language has stereo. If that language lacks stereo, creates one generated track from the best same-language source, preferring 5.1/6-channel over 7.1/8-channel. Disable it to create one for every non-stereo audio stream/language. |

Compared with releases before `1.1.11`, the default tested contract when `Add Generated 2-Channel Track=true` includes generated 2-channel fallback work, and parity is checked for both the original audio stream and the generated fallback. Older release rows below used the previous primary-stream speed table, so treat the timing comparison as release history rather than a strict same-workload benchmark.

| Version | 10min GPU Time | 30min GPU Time | Exact Stats Time | Exact Apply Time | Speed Change vs Previous |
| --- | ---: | ---: | ---: | ---: | --- |
| `1.2.8` | `71.1s` | `202.8s` | `26.1s` | `124.2s` | ![60min combined 14% faster vs 1.2.7](https://img.shields.io/badge/60min%20combined-14%25%20faster-brightgreen)<br>![30min combined 16% faster vs 1.2.7](https://img.shields.io/badge/30min%20combined-16%25%20faster-brightgreen)<br>![10min combined 17% faster vs 1.2.7](https://img.shields.io/badge/10min%20combined-17%25%20faster-brightgreen)<br>![stereo fallback crash fixed](https://img.shields.io/badge/stereo%20fallback%20crash-fixed-blue)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.2.7` | `86.1s` | `241.0s` | `26.9s` | `140.0s` | ![60min combined 30% faster vs 1.2.6](https://img.shields.io/badge/60min%20combined-30%25%20faster-brightgreen)<br>![30min combined 26% faster vs 1.2.6](https://img.shields.io/badge/30min%20combined-26%25%20faster-brightgreen)<br>![10min combined 22% faster vs 1.2.6](https://img.shields.io/badge/10min%20combined-22%25%20faster-brightgreen)<br>![long speed target passed](https://img.shields.io/badge/long%20speed%20target-passed-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.2.6` | `58.1s` | `172.2s` | `22.7s` | `133.1s` | ![60min GPU 19% faster vs 1.2.5](https://img.shields.io/badge/60min%20GPU-19%25%20faster-brightgreen)<br>![30min GPU 16% faster vs 1.2.5](https://img.shields.io/badge/30min%20GPU-16%25%20faster-brightgreen)<br>![10min GPU 13% faster vs 1.2.5](https://img.shields.io/badge/10min%20GPU-13%25%20faster-brightgreen)<br>![long speed target passed](https://img.shields.io/badge/long%20speed%20target-passed-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.2.5` | `120.3s` | `359.2s` | `19.6s` | `100.0s` | ![60min GPU 79% faster](https://img.shields.io/badge/60min%20GPU-79%25%20faster-brightgreen)<br>![30min GPU 93% faster](https://img.shields.io/badge/30min%20GPU-93%25%20faster-brightgreen)<br>![10min GPU 81% faster](https://img.shields.io/badge/10min%20GPU-81%25%20faster-brightgreen)<br>![long speed target passed](https://img.shields.io/badge/long%20speed%20target-passed-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.2.4` | `134.8s` | `400.8s` | `20.3s` | `122.1s` | ![60min GPU 62% faster](https://img.shields.io/badge/60min%20GPU-62%25%20faster-brightgreen)<br>![30min GPU 74% faster](https://img.shields.io/badge/30min%20GPU-74%25%20faster-brightgreen)<br>![10min GPU 62% faster](https://img.shields.io/badge/10min%20GPU-62%25%20faster-brightgreen)<br>![fallback to undetected added](https://img.shields.io/badge/fallback%20to%20undetected-added-blue)<br>![safe no-audio guard](https://img.shields.io/badge/no--audio%20guard-added-blue)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.2.3` | `144.2s` | `405.3s` | `215.4s` | `121.2s` | ![60min GPU 64% faster](https://img.shields.io/badge/60min%20GPU-64%25%20faster-brightgreen)<br>![30min GPU 72% faster](https://img.shields.io/badge/30min%20GPU-72%25%20faster-brightgreen)<br>![10min GPU 52% faster](https://img.shields.io/badge/10min%20GPU-52%25%20faster-brightgreen)<br>![structural cleanup](https://img.shields.io/badge/structural%20cleanup-added-blue)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.2.2` | `177.5s` | `450.6s` | `210.6s` | `124.0s` | ![30min GPU 54% faster](https://img.shields.io/badge/30min%20GPU-54%25%20faster-brightgreen)<br>![10min GPU 23% faster](https://img.shields.io/badge/10min%20GPU-23%25%20faster-brightgreen)<br>![remove other languages added](https://img.shields.io/badge/remove%20other%20languages-added-blue)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.2.1` | `150.9s` | `438.5s` | `244.3s` | `131.9s` | ![60min GPU 53% faster](https://img.shields.io/badge/60min%20GPU-53%25%20faster-brightgreen)<br>![30min GPU 59% faster](https://img.shields.io/badge/30min%20GPU-59%25%20faster-brightgreen)<br>![10min GPU 45% faster](https://img.shields.io/badge/10min%20GPU-45%25%20faster-brightgreen)<br>![language filter added](https://img.shields.io/badge/language%20filter-added-blue)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.2.0` | `155.7s` | `452.3s` | `261.5s` | `138.1s` | ![60min GPU 47% faster](https://img.shields.io/badge/60min%20GPU-47%25%20faster-brightgreen)<br>![30min GPU 54% faster](https://img.shields.io/badge/30min%20GPU-54%25%20faster-brightgreen)<br>![10min GPU 40% faster](https://img.shields.io/badge/10min%20GPU-40%25%20faster-brightgreen)<br>![fallback scope fixed](https://img.shields.io/badge/fallback%20scope-fixed-blue)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.1.13` | `155.3s` | `456.8s` | `262.2s` | `138.7s` | ![10min GPU 27% faster](https://img.shields.io/badge/10min%20GPU-27%25%20faster-brightgreen)<br>![30min GPU 24% faster](https://img.shields.io/badge/30min%20GPU-24%25%20faster-brightgreen)<br>![60min GPU 23% faster](https://img.shields.io/badge/60min%20GPU-23%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.1.12` | `196.5s` | `568.4s` | `222.0s` | `169.5s` | ![10min GPU 11% faster](https://img.shields.io/badge/10min%20GPU-11%25%20faster-brightgreen)<br>![30min GPU 12% faster](https://img.shields.io/badge/30min%20GPU-12%25%20faster-brightgreen)<br>![60min GPU 13% faster](https://img.shields.io/badge/60min%20GPU-13%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.1.11` | `217.2s` | `634.9s` | `252.9s` | `162.8s` | ![30min GPU 7% faster](https://img.shields.io/badge/30min%20GPU-7%25%20faster-brightgreen)<br>![60min GPU 11% faster](https://img.shields.io/badge/60min%20GPU-11%25%20faster-brightgreen)<br>![5.1 parity passed](https://img.shields.io/badge/5.1%20parity-passed-brightgreen)<br>![+2ch parity passed](https://img.shields.io/badge/%2B2ch%20parity-passed-brightgreen) |
| `1.1.10` | `114.9s` | `334.0s` | `108.5s` | `97.9s` | ![10min +21%](https://img.shields.io/badge/10min-%2B21%25-brightgreen)<br>![30min +21%](https://img.shields.io/badge/30min-%2B21%25-brightgreen) |

Choose `1.2.8` for current parity, the fastest validated long combined jobs, the stereo-fallback crash fix, accepted long-media scheduling/defaults, fallback to undetected audio when language tags are missing, safe no-audio failure behavior, and release/diagnostic tooling hardening. Use `1.2.7` only if you need the previous speed-release snapshot.

For `1.2.3`, the exact-stats workers run as an overlapped pair. The history row lists the slower worker time, not the sum of both overlapped worker counters.

## Versions

| Version | Use |
| --- | --- |
| `1.2.8` | Current release. Promotes the accepted long-media optimization defaults, fixes a post-success generated-stereo fallback teardown crash, and matches CPU decoded output for normalized 5.1 plus generated 2-channel fallback on the validated matrix. |
| `1.2.7` | Previous release. Runs same-source original plus generated 2-channel fallback routes in parallel on long jobs, keeps short-media CPU first-pass for codec parity, and matches CPU decoded output for normalized 5.1 plus generated 2-channel fallback on the full validated matrix. |
| `1.2.6` | Previous release. Uses original-only GPU first-pass acceleration to speed up long 5.1 plus generated 2-channel fallback jobs, keeps fallback to undetected audio and safe no-audio failure behavior, and matches CPU decoded output for normalized 5.1 plus generated 2-channel fallback on the full validated matrix. |
| `1.2.5` | Previous release. Speeds up long 5.1 plus generated 2-channel fallback jobs, keeps fallback to undetected audio and safe no-audio failure behavior, and matches CPU decoded output for normalized 5.1 plus generated 2-channel fallback on the full validated matrix. |
| `1.2.4` | Previous release. Adds fallback to undetected audio, fails safely if selected language removal would leave no audio, keeps faster-than-CPU long combined jobs, and matches CPU decoded output for normalized 5.1 plus generated 2-channel fallback on the full validated matrix. |
| `1.2.3` | Previous release. Improves long combined-job speed, keeps default-on removal of audio languages outside `Normalize ONLY Languages`, adds release manifest checks and process cleanup hardening, and matches CPU decoded output for normalized 5.1 plus generated 2-channel fallback on the full validated matrix. |
| `1.2.2` | Previous release. Adds default-on removal of audio languages outside `Normalize ONLY Languages`, keeps opt-out copy behavior, promotes current speed defaults, and matches CPU decoded output for normalized 5.1 plus generated 2-channel fallback on validated cases. |
| `1.2.1` | Previous release. Adds language-only normalization, no-match pass-through, cleaner default logs, deploy cleanup, and matches CPU decoded output for normalized 5.1 plus generated 2-channel fallback on the required matrix. |
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
