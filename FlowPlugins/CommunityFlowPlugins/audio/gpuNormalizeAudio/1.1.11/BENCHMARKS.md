# GPU Normalize Audio 1.1.11 Benchmarks

These release results compare GPU Normalize Audio `1.1.11` against Tdarr CPU `Normalize Audio` decoded output.

Contract:

- Source case: 5.1 media with no existing stereo track.
- GPU output: normalized original 5.1 stream plus generated normalized 2-channel fallback.
- CPU reference: CPU `Normalize Audio` main output plus CPU `Normalize Audio` run on a generated 2-channel source from the selected fallback source stream.
- Compare: both decoded output streams must match with `energy_similarity=1.000000000` and `max_rms_diff=0`.
- Default fallback scope: first non-stereo language after `Track Order=eng,en` sorting.
- Streaming mode: `gpuSourcePort`.
- Output: `192k` AAC.
- Codec smoke: AAC stereo, MP3 stereo, AC3 5.1, E-AC-3 5.1, DTS 5.1, and multi-audio inputs.

`Speed vs CPU` above `1.0x` is faster than CPU. Values below `1.0x` are slower.

| Case | Workload | CPU reference | GPU 1.1.11 | Speed vs CPU | Result |
| --- | --- | ---: | ---: | ---: | --- |
| 30s | Original 5.1 | `9.4s` | `8.6s` | `1.092x` | Pass, exact parity |
| 30s | Generated 2ch | `2.6s` | `12.4s` | `0.208x` | Pass, exact parity |
| 30s | Combined | `11.9s` | `21.1s` | `0.567x` | Pass, both streams exact |
| 60s | Original 5.1 | `18.2s` | `13.7s` | `1.326x` | Pass, exact parity |
| 60s | Generated 2ch | `4.8s` | `17.0s` | `0.285x` | Pass, exact parity |
| 60s | Combined | `23.0s` | `30.8s` | `0.746x` | Pass, both streams exact |
| 10min | Original 5.1 | `175.2s` | `105.2s` | `1.665x` | Pass, exact parity |
| 10min | Generated 2ch | `48.4s` | `111.2s` | `0.435x` | Pass, exact parity |
| 10min | Combined | `223.6s` | `217.2s` | `1.030x` | Pass, both streams exact |
| 30min | Original 5.1 | `529.0s` | `310.6s` | `1.703x` | Pass, exact parity |
| 30min | Generated 2ch | `149.1s` | `322.2s` | `0.463x` | Pass, exact parity |
| 30min | Combined | `678.0s` | `634.9s` | `1.068x` | Pass, both streams exact |
| 60min | Original 5.1 | `1072.6s` | `609.3s` | `1.760x` | Pass, exact parity |
| 60min | Generated 2ch | `297.2s` | `621.7s` | `0.478x` | Pass, exact parity |
| 60min | Combined | `1369.8s` | `1237.2s` | `1.107x` | Pass, both streams exact |

Codec smoke also passed exact decoded parity for AAC stereo, MP3 stereo, AC3 5.1, E-AC-3 5.1, DTS 5.1, and a multi-audio sample. Multi-audio smoke compares each GPU-normalized original stream against the original CPU `Normalize Audio` plugin run on an isolated source for that same stream, matching this plugin's per-stream normalization contract.

Short clips remain slower because fixed startup, stream setup, and FFmpeg overhead dominate. Long media is the intended target for the current GPU path.
