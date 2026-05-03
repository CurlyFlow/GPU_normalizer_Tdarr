#!/usr/bin/env python3
from __future__ import annotations

import argparse
import array
import json
import math
import re
import subprocess
import time
from pathlib import Path


FFMPEG = "/usr/local/bin/tdarr-ffmpeg"
CPU_CORE = "/app/server/opx/bin/opx-loudnorm-source-cpu.plugin-dev"
GPU_CORE = "/app/server/opx/bin/opx-loudnorm-gpu-source-port"


def run(cmd: list[str], stderr_path: Path | None = None) -> str:
    started = time.perf_counter()
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    elapsed = time.perf_counter() - started
    text = proc.stdout + proc.stderr
    if stderr_path is not None:
        stderr_path.write_text(text)
    if proc.returncode != 0:
        raise RuntimeError(f"command failed rc={proc.returncode}: {' '.join(cmd)}\n{text[-4000:]}")
    return text + f"\n__elapsed_sec={elapsed:.6f}\n"


def raw_metrics(path: Path, rate: int, channels: int) -> dict[str, float | None]:
    def ff(args: list[str]) -> str:
        proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        return proc.stdout + proc.stderr

    common = [FFMPEG, "-hide_banner", "-nostdin", "-f", "f32le", "-ac", str(channels), "-ar", str(rate), "-i", str(path), "-vn"]
    vol = ff(common + ["-af", "volumedetect", "-f", "null", "-"])
    ebu = ff(common + ["-filter_complex", "ebur128=peak=true", "-f", "null", "-"])
    summary = ebu[ebu.rfind("Summary:"):]
    out: dict[str, float | None] = {}
    patterns = {
        "mean_volume": (r"mean_volume:\s*([-0-9.]+) dB", vol),
        "max_volume": (r"max_volume:\s*([-0-9.]+) dB", vol),
        "integrated_lufs": (r"I:\s*([-0-9.]+) LUFS", summary),
        "lra_lu": (r"LRA:\s*([-0-9.]+) LU", summary),
        "true_peak_dbfs": (r"Peak:\s*([-0-9.]+) dBFS", summary),
    }
    for key, (pattern, text) in patterns.items():
        match = re.search(pattern, text)
        out[key] = float(match.group(1)) if match else None
    return out


def compare_raw(reference: Path, candidate: Path) -> dict[str, float | int]:
    n = min(reference.stat().st_size, candidate.stat().st_size) // 4
    ss = 0.0
    dd = 0.0
    peak = 0.0
    equal = 0
    with reference.open("rb") as fa, candidate.open("rb") as fb:
        left = n
        while left:
            m = min(262144, left)
            ar = array.array("f")
            br = array.array("f")
            ar.frombytes(fa.read(m * 4))
            br.frombytes(fb.read(m * 4))
            for x, y in zip(ar, br):
                d = x - y
                ss += x * x
                dd += d * d
                if abs(d) > peak:
                    peak = abs(d)
                if x == y:
                    equal += 1
            left -= m
    return {
        "samples": n,
        "sdr_db": 10.0 * math.log10(ss / dd) if dd and ss else 999.0,
        "diff_rel_db": 10.0 * math.log10(dd / ss) if dd and ss else -999.0,
        "rms_diff": math.sqrt(dd / n) if dd else 0.0,
        "peak_diff": peak,
        "equal_fraction": equal / n if n else 0.0,
        "energy_similarity": 1.0 - (dd / ss) if ss else 0.0,
    }


def parse_planner_timing(text: str) -> dict[str, float]:
    out: dict[str, float] = {}
    for key in ["stats_wall_sec", "gain_wall_sec", "apply_wall_sec", "elapsed_sec", "realtime_x", "__elapsed_sec"]:
        match = re.search(rf"{re.escape(key)}=([-0-9.]+)", text)
        if match:
            out[key.strip("_")] = float(match.group(1))
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--workdir", required=True)
    parser.add_argument("--rate", type=int, default=192000)
    parser.add_argument("--channels", type=int, required=True)
    parser.add_argument("--target-i", type=float, default=-18.0)
    parser.add_argument("--target-lra", type=float, default=7.0)
    parser.add_argument("--target-tp", type=float, default=-2.0)
    parser.add_argument("--chunk-mib", type=float, default=64.0)
    parser.add_argument("--max-pcm-mib", type=float, default=8192.0)
    parser.add_argument("--skip-cpu", action="store_true")
    parser.add_argument("--reference")
    args = parser.parse_args()

    inp = Path(args.input)
    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", args.label)
    cpu_out = workdir / f"{stem}.cpu.f32"
    gpu_out = workdir / f"{stem}.gpu.f32"
    gains = workdir / f"{stem}.cpu.gains.f32"
    cpu_log = workdir / f"{stem}.cpu.log"
    gpu_log = workdir / f"{stem}.gpu.log"

    cpu_text = ""
    if not args.skip_cpu:
        cpu_text = run([
            CPU_CORE, str(inp), str(cpu_out), str(args.rate), str(args.channels), str(gains),
            str(args.target_i), str(args.target_lra), str(args.target_tp),
        ], cpu_log)
    reference = Path(args.reference) if args.reference else cpu_out

    gpu_text = run([
        GPU_CORE, str(inp), str(gpu_out),
        "--rate", str(args.rate), "--channels", str(args.channels),
        "--target-i", str(args.target_i), "--target-lra", str(args.target_lra), "--target-tp", str(args.target_tp),
        "--chunk-mib", str(args.chunk_mib), "--max-pcm-mib", str(args.max_pcm_mib),
    ], gpu_log)

    result = {
        "label": args.label,
        "input": str(inp),
        "rate": args.rate,
        "channels": args.channels,
        "target": {"i": args.target_i, "lra": args.target_lra, "tp": args.target_tp},
        "chunk_mib": args.chunk_mib,
        "cpu_output": str(cpu_out) if not args.skip_cpu else None,
        "gpu_output": str(gpu_out),
        "reference": str(reference),
        "cpu_timing": parse_planner_timing(cpu_text) if cpu_text else None,
        "gpu_timing": parse_planner_timing(gpu_text),
        "cpu_metrics": raw_metrics(cpu_out, args.rate, args.channels) if not args.skip_cpu else None,
        "gpu_metrics": raw_metrics(gpu_out, args.rate, args.channels),
        "similarity": compare_raw(reference, gpu_out),
    }
    out_path = workdir / f"{stem}.json"
    out_path.write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
