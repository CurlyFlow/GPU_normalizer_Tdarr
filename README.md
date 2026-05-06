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

Latest release: `v1.1.3`.

`1.1.3` is faster than `1.1.2`, but long limiter-heavy media is still slower than Tdarr's CPU-only `Normalize Audio` plugin.

| Case | CPU `Normalize Audio` | GPU `1.1.3` | Result |
| --- | ---: | ---: | --- |
| 12s 5.1 | `4.2s` | `2.3s` | GPU faster, parity passed. |
| 60s | `16.7s` | `55.7s` | GPU slower, parity passed. |
| 30min 5.1 | `544.0s` | `1695.0s` | GPU slower, parity passed. |

Compared with `1.1.2` on the required 30min case:

| Version | 30min GPU Time | Exact Apply Time |
| --- | ---: | ---: |
| `1.1.2` | `2488.1s` | `1992.9s` |
| `1.1.3` | `1695.0s` | `1168.9s` |

So `1.1.3` is about `32%` less total time than `1.1.2` on the 30min validation case, while still matching CPU decoded output.

## Install

Download the latest GitHub release zip and extract it into your Tdarr plugins folder.

Keep the version folder. Do not flatten it.

Correct layout:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.1.3/
```

Tdarr loads:

```text
FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.1.3/index.js
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
| `1.1.3` | Current release. Faster limiter-active GPU path, required parity matrix passed. Still slower than CPU on long limiter-heavy media. |
| `1.1.2` | Streaming two-pass release. Avoids huge raw PCM bridge files and fixed long-case parity. |
| `1.1.1` | Added guarded GPU normalize concurrency. |
| `1.1` | Older optimized exact GPU line. |
| `1.0` | First stable CPU-output matching line. |
| `0.0.x` | Old pre-stable snapshots. Some are known not to match CPU normalizer output. Use only for rollback/debug. |

## Notes

This project is still performance work in progress. The quality target is CPU-normalizer decoded output behavior with GPU acceleration, not a separate audio result that only sounds close.

<img width="1587" height="1443" alt="image" src="https://github.com/user-attachments/assets/9fc7119d-2caa-4bcf-b08b-f857e450f931" />
