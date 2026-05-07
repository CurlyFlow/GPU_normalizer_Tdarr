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

## Performance

Latest release: `v1.1.5`.

`1.1.5` is a maintainability refactor of the GPU runtime. Performance is effectively unchanged from `1.1.4`, and long limiter-heavy media is still slower than Tdarr's CPU-only `Normalize Audio` plugin.

`Speed vs CPU` uses the release-note value: above `1.0x` is faster than CPU, below `1.0x` is slower than CPU.

| Case | CPU `Normalize Audio` | GPU `1.1.5` | Speed vs CPU | Result |
| --- | ---: | ---: | ---: | --- |
| 30s | `10.1s` | `24.9s` | `0.406x` | GPU `59%` slower than CPU, parity passed. |
| 60s | `16.7s` | `50.1s` | `0.334x` | GPU `67%` slower than CPU, parity passed. |
| 30min | `544.0s` | `1513.4s` | `0.359x` | GPU `64%` slower than CPU, parity passed. |

Compared with `1.1.4`, the runtime refactor stayed within normal run noise:

| Version | 60s GPU Time | 30min GPU Time | Exact Stats Time | Exact Apply Time |
| --- | ---: | ---: | ---: | ---: |
| `1.1.4` | `49.9s` | `1507.6s` | `114.8s` | `1158.3s` |
| `1.1.5` | `50.1s` | `1513.4s` | `114.9s` | `1158.5s` |

So `1.1.5` should be chosen for maintainability and release packaging cleanup, not for a speed claim. It still matches CPU decoded output on the required matrix.

## Install

Download the latest GitHub release zip and extract it into your Tdarr plugins folder.

Keep the version folder. Do not flatten it.

Correct layout:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.1.5/
```

Tdarr loads:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.1.5/index.js
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
| `1.1.5` | Current release. Modularized GPU runtime, required parity matrix passed. Performance is effectively unchanged from `1.1.4`; still slower than CPU on long limiter-heavy media. |
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
