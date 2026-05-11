# GPU Normalize Audio 1.1.11 Benchmarks

These release results compare GPU Normalize Audio `1.1.11` against Tdarr CPU `Normalize Audio` decoded output.

Contract:

- Source case: 5.1 media with no existing stereo track.
- GPU output: normalized original 5.1 stream plus generated normalized 2-channel fallback.
- CPU reference: CPU `Normalize Audio` main output plus CPU `Normalize Audio` run on a generated 2-channel source from the first audio stream.
- Compare: both decoded output streams must match with `energy_similarity=1.000000000` and `max_rms_diff=0`.
- Default fallback scope: first audio stream only.
- Streaming mode: `gpuSourcePort`.
- Output: `192k` AAC.

`Speed vs CPU` above `1.0x` is faster than CPU. Values below `1.0x` are slower.

| Case | CPU contract | GPU 1.1.11 | Speed vs CPU | Result |
| --- | ---: | ---: | ---: | --- |
| 30s | `11.9s` | `21.1s` | `0.567x` | Pass, 5.1 + generated 2ch exact parity |
| 60s | `23.0s` | `30.8s` | `0.746x` | Pass, 5.1 + generated 2ch exact parity |
| 10min | `223.6s` | `217.2s` | `1.030x` | Pass, 5.1 + generated 2ch exact parity |
| 30min | `678.0s` | `634.9s` | `1.068x` | Pass, 5.1 + generated 2ch exact parity |
| 60min | `1369.8s` | `1237.2s` | `1.107x` | Pass, 5.1 + generated 2ch exact parity |

Codec smoke also passed exact decoded parity for AAC stereo, MP3 stereo, AC3 5.1, E-AC-3 5.1, DTS 5.1, and a multi-audio sample. Multi-audio smoke compares each GPU-normalized original stream against the original CPU `Normalize Audio` plugin run on an isolated source for that same stream, matching this plugin's per-stream normalization contract.

Short clips remain slower because fixed startup, stream setup, and FFmpeg overhead dominate. Long media is the intended target for the current GPU path.
