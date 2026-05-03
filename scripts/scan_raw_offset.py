#!/usr/bin/env python3
from __future__ import annotations

import argparse
import array
import math
from pathlib import Path


def read_f32(path: Path) -> array.array:
    data = array.array("f")
    data.frombytes(path.read_bytes())
    return data


def score(ref: array.array, cand: array.array, channels: int, frame_offset: int) -> tuple[float, float]:
    if frame_offset >= 0:
        ref_start = frame_offset * channels
        cand_start = 0
    else:
        ref_start = 0
        cand_start = (-frame_offset) * channels
    n = min(len(ref) - ref_start, len(cand) - cand_start)
    if n <= 0:
        return -999.0, 0.0
    ss = 0.0
    dd = 0.0
    for i in range(n):
        x = ref[ref_start + i]
        y = cand[cand_start + i]
        d = x - y
        ss += x * x
        dd += d * d
    if not dd or not ss:
        return 999.0, 1.0
    return 10.0 * math.log10(ss / dd), 1.0 - dd / ss


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("ref")
    p.add_argument("cand")
    p.add_argument("--channels", type=int, required=True)
    p.add_argument("--rate", type=int, default=192000)
    p.add_argument("--min-ms", type=int, default=-4000)
    p.add_argument("--max-ms", type=int, default=4000)
    p.add_argument("--step-ms", type=int, default=10)
    args = p.parse_args()
    ref = read_f32(Path(args.ref))
    cand = read_f32(Path(args.cand))
    best = None
    for ms in range(args.min_ms, args.max_ms + 1, args.step_ms):
        frame_offset = int(round(args.rate * ms / 1000.0))
        sdr, sim = score(ref, cand, args.channels, frame_offset)
        row = (sdr, sim, ms, frame_offset)
        if best is None or row[0] > best[0]:
            best = row
    assert best is not None
    print(f"best_sdr_db={best[0]:.6f} energy_similarity={best[1]:.12f} offset_ms={best[2]} frame_offset={best[3]}")


if __name__ == "__main__":
    main()
