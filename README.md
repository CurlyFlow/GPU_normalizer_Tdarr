# GPU Normalize Audio for Tdarr

[![Latest Release](https://img.shields.io/badge/release-v1.2.9-blue)](release-notes/1.2.9.md)
[![CPU Parity](https://img.shields.io/badge/CPU%20parity-100%25%20exact-brightgreen)](#performance)
[![Speed vs CPU](https://img.shields.io/badge/90min%20speed-5.26x%20vs%20CPU-brightgreen)](#performance)

> [!WARNING]
> **USE AT YOUR OWN RISK · WIP** — *It might burn your house ;-)*

A Tdarr FlowPlugin that moves FFmpeg `loudnorm`-style audio normalization onto CUDA GPUs while matching Tdarr's CPU-only `Normalize Audio` output **sample-for-sample (`100%` decoded parity)**.

- **Exact CPU parity first:** Verified against Tdarr CPU `Normalize Audio` (`energy_similarity=1.000000000`, `rms_diff=0`) across long 5.1 + generated stereo jobs and codec smokes (AAC, MP3, AC3, E-AC-3, DTS, multi-audio).
- **Fast on long media:** `4.5x`–`5.3x` faster than CPU (`24%`–`34%` faster than `1.2.8`) using streaming two-pass `gpuSourcePort` — no giant raw PCM temp files.
- **Full stream preservation:** Normalizes selected audio streams (or all streams) while preserving video, subtitles, chapters, metadata, attachments, data streams, and zero-tolerance ISO MP4/MOV timing clocks.

---

## Performance

Tested on **i9-9900K @ 5 GHz (CPU reference)** vs. **NVIDIA GTX 1050 Ti (GPU `1.2.9`)** using a 5.1 source with no existing stereo track (combined workload = normalized original 5.1 + generated normalized 2-channel fallback, both verified against Tdarr CPU `Normalize Audio`).

`Speed vs CPU` is measured `SRC_CPU / GPU` wall time: above `1.0x` is faster than CPU, below `1.0x` is slower. Short smoke clips are used for parity checks only and are excluded here.

| Length | CPU Reference | GPU `1.2.9` | Speed vs CPU | vs `1.2.8` | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| **90 min** | `2193.2s` | **`416.9s`** | **`5.260x`** | `-34.1%` | 426% faster · 5.1 & +2ch parity passed |
| **60 min** | `1374.8s` | **`303.5s`** | **`4.529x`** | `-24.0%` | 353% faster · 5.1 & +2ch parity passed |
| **30 min** | `688.7s` | **`139.4s`** | **`4.940x`** | `-31.3%` | 394% faster · 5.1 & +2ch parity passed |
| **10 min** | `262.8s` | **`51.5s`** | **`5.104x`** | `-27.6%` | 410% faster · 5.1 & +2ch parity passed |

<details>
<summary>Per-stream breakdown (Original 5.1 vs. Generated 2ch)</summary>

| Length | Stream | CPU Reference | GPU `1.2.9` | Speed vs CPU | Result |
| --- | --- | ---: | ---: | ---: | --- |
| 90 min | Original 5.1 | `1744.5s` | `320.2s` | `5.449x` | 445% faster · 5.1 parity passed |
| 90 min | Generated 2ch | `448.7s` | `342.6s` | `1.310x` | 31% faster · +2ch parity passed |
| 60 min | Original 5.1 | `1083.0s` | `252.9s` | `4.282x` | 328% faster · 5.1 parity passed |
| 60 min | Generated 2ch | `291.8s` | `254.1s` | `1.148x` | 15% faster · +2ch parity passed |
| 30 min | Original 5.1 | `541.8s` | `111.7s` | `4.850x` | 385% faster · 5.1 parity passed |
| 30 min | Generated 2ch | `146.8s` | `117.2s` | `1.253x` | 25% faster · +2ch parity passed |
| 10 min | Original 5.1 | `210.6s` | `41.3s` | `5.099x` | 410% faster · 5.1 parity passed |
| 10 min | Generated 2ch | `52.2s` | `42.7s` | `1.221x` | 22% faster · +2ch parity passed |

</details>

**What's new in `1.2.9`:** CUDA-owned `192k -> 96k` & `48k -> 192k` SWR resampling, parallel limiter/safe-skip kernels, fused multi-threaded AVX2-FMA native channel stats, bit-exact parallel multi-channel AAC-LC encoding (`aac_encode_mt`), and single-pass direct clock final muxing (`audio_clock_mux`). See [release-notes/1.2.9.md](release-notes/1.2.9.md) for full details and codec/language-scope smoke coverage.

---

## Plugin UI

<img width="1305" height="661" alt="GPU Normalize Audio Plugin UI" src="https://github.com/user-attachments/assets/4ff69be3-772a-4554-beef-93cda9dc7c06" />

---

## Install & Update

### 1-Command Install / Update (Recommended)

Run on your Tdarr host against your `server/Tdarr/Plugins` directory — the same command installs and updates safely into `LocalFlowPlugins` (never wiped by Tdarr's *Update Community Plugins*):

```bash
curl -fsSL https://raw.githubusercontent.com/CurlyFlow/GPU_normalizer_Tdarr/main/install.sh \
  | bash -s -- /path/to/tdarr/server/Tdarr/Plugins
```

*(Tip: add `--channel latest` before the path if you want a single `latest` folder so existing Flows automatically pick up updates without re-selecting the node version.)*

### Manual Install

1. Download `GPU_normalize_audio_tdarr-1.2.9.zip` from GitHub Releases.
2. Extract it into your Tdarr plugins directory **keeping the version folder** (do not flatten):

   ```text
   FlowPlugins/LocalFlowPlugins/audio/gpuNormalizeAudio/1.2.9/index.js
   ```
3. In Tdarr WebUI click **Sync Plugins** (or restart Tdarr Server/Node) and select **GPU Normalize Audio** under **Local** Flow Plugins.

> [!TIP]
> **Docker CUDA library path:** If CUDA loading fails with `libcuda.so.1: file too short` (or resolves the wrong driver library), set this on your Tdarr container:
> ```bash
> -e LD_LIBRARY_PATH=/usr/lib64:/usr/lib/x86_64-linux-gnu
> ```

---

## Settings & Defaults

| Setting | Default | Description |
| --- | --- | --- |
| `Add Generated 2-Channel Track` | `true` | Adds normalized generated stereo track(s) according to the 2-channel scope. |
| `Only Generate 2-Channel For First Language` | `true` | Generates stereo only for the first `Track Order` language (preferring 5.1 over 7.1). Disable to generate for every non-stereo stream/language. |
| `Track Order` | `eng, en` | Comma-separated language priority for track ordering and generated stereo selection (unlisted languages keep source order). |
| `Normalize ONLY Languages` | `eng, en` | Comma-separated language filter. Clear or enter `all` / `*` to normalize every audio stream. |
| `Remove Other Languages` | `false` | Off (default) copies audio streams outside `Normalize ONLY Languages` unchanged. Enable to delete unselected languages. |
| `Fallback To Undetected Audio` | `true` | Keeps undetected-language (`und`) streams when no selected language exists instead of routing to Output 2. |
| `Audio Bitrate` | `192k` | Target AAC audio bitrate (release parity and speed are validated at `192k`). |
| `Prepare Audio For MP4` | `false` | Converts retained MP4-incompatible audio codecs to AAC inside this plugin when a later flow step remuxes to MP4 (keeps container, video, and already-compatible audio unchanged). |
| `Integrated Loudness I` / `LRA` / `TP` | `-18.0` / `7.0` / `-2.0` | Standard `loudnorm` loudness (LUFS), range (LU), and true-peak (dBTP) targets. |
| `Max Gain dB` | `15` | Safety gate in dB: streams needing more gain than this are copied unchanged instead of normalized (`0` disables the gate). |
| `Max Concurrent CPU Tasks` | `1` | Host-wide CPU concurrency limit across running jobs and plugins for muxing, copy-only runs, and verification (`0` disables the guard). |
| `Max Concurrent GPU Tasks` | `1` | Host-wide GPU concurrency limit across running jobs and plugins (`0` disables the guard). |
| `Debug Logging` | `false` | Enables verbose FFmpeg/runtime logs for troubleshooting. |

**Flow Outputs:**
- **Output 1:** Output file with normalized/copied audio, optional generated stereo, and preserved video/subtitles/chapters/metadata.
- **Output 2:** No audio or no selected audio remains (the plugin never deletes files or Tdarr entries; connect a downstream handler if desired).

---

## Architecture

Active source lives in [`src/gpuNormalizeAudio/`](src/gpuNormalizeAudio/); immutable release snapshots live under [`FlowPlugins/LocalFlowPlugins/audio/gpuNormalizeAudio/`](FlowPlugins/LocalFlowPlugins/audio/gpuNormalizeAudio/1.2.9/) (older `<= 1.2.8` releases remain available via Git tags and GitHub Releases).

- **Tdarr Plugin & Planner (JS):** [`src/gpuNormalizeAudio/index.js`](src/gpuNormalizeAudio/index.js) & [`lib/`](src/gpuNormalizeAudio/lib/) — stream selection, language ordering, stereo fallback planning, GPU lock coordination, and direct clock final muxing.
- **Streaming Runtime & Native Helpers (Python / C):** [`src/gpuNormalizeAudio/runtime/bin/`](src/gpuNormalizeAudio/runtime/bin/) — streaming two-pass orchestration plus native C helpers (`audio_clock_mux`, `aac_encode_mt`, `opx_loudnorm_channel_stats`).
- **CUDA Kernels (CUDA C/C++):** [`src/gpuNormalizeAudio/runtime/cuda/`](src/gpuNormalizeAudio/runtime/cuda/) — GPU ports of FFmpeg `af_loudnorm.c` EBU R128 loudness, true-peak, dynamic gain/limiter feedback, and exact SWR resampling.
- **Parity Diagnostics & Gates:** [`diagnostics/`](diagnostics/) (sample-accurate `f32le` diff tools) and [`scripts/`](scripts/) (contract, manifest, and quality checks).

---

## Release History

Use **`1.2.9`** for the fastest validated long-media performance and exact `100%` CPU parity ([release notes](release-notes/1.2.9.md)).

<details>
<summary>Older versions & timing history (1.2.9 → 0.0.x)</summary>

> Note: Releases from `1.1.11` onward benchmark the combined 5.1 + generated 2ch default workload (`Add Generated 2-Channel Track=true`); earlier rows measured primary-stream only.

| Version | 10 min GPU | 30 min GPU | Summary |
| --- | ---: | ---: | --- |
| **`1.2.9`** | `51.5s` | `139.4s` | CUDA SWR resampling, parallel AAC-LC (`aac_encode_mt`), fused MT stats, direct clock mux (`24%`–`34%` faster than `1.2.8`, `100%` parity). |
| `1.2.8` | `71.1s` | `202.8s` | Promoted long-media defaults, fixed post-success stereo fallback teardown crash (`14%`–`17%` faster than `1.2.7`). |
| `1.2.7` | `86.1s` | `241.0s` | Parallel same-source 5.1 + generated 2ch routes on long jobs (`22%`–`30%` faster than `1.2.6`). |
| `1.2.6` | `58.1s` | `172.2s` | Original-only GPU first-pass acceleration (`13%`–`19%` faster than `1.2.5`). |
| `1.2.5` | `120.3s` | `359.2s` | Faster long 5.1 + 2ch combined jobs with exact parity. |
| `1.2.4` | `134.8s` | `400.8s` | Added fallback to undetected audio and safe no-audio failure guard. |
| `1.2.3` | `144.2s` | `405.3s` | Overlapped stats workers, release manifest checks, process cleanup hardening. |
| `1.2.2` | `177.5s` | `450.6s` | Added default-on `Remove Other Languages` with opt-out copy behavior. |
| `1.2.1` | `150.9s` | `438.5s` | Added `Normalize ONLY Languages`, no-match pass-through, cleaner default logs. |
| `1.2.0` | `155.7s` | `452.3s` | Fixed generated-stereo first-language scope. |
| `1.1.11`–`1.1.13` | `155.3s`–`217.2s` | `456.8s`–`634.9s` | Language-priority controls and iterative long-media stereo fallback speedups. |
| `1.1.0`–`1.1.10` | `114.9s` | `334.0s` | Streaming two-pass `gpuSourcePort`, GPU concurrency lock, and safe feedback-skip kernels. |
| `1.0` | — | — | First stable CPU-output matching line. |
| `0.0.x` | — | — | Pre-stable snapshots (some known not to match CPU output; rollback/debug only). |

</details>
