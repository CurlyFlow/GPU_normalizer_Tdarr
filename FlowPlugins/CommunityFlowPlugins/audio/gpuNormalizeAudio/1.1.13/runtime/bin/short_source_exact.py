from __future__ import annotations

import os
import re
import subprocess
import sys
import time


def try_short_source_exact(args, cfg, emit_progress):
    if not (cfg.seconds < 30.0 and not args.disable_short_source_exact):
        return False

    emit_progress('short_source_exact', 0.01)
    source_core = args.source_core_path
    if not os.path.exists(source_core):
        raise SystemExit(f'short source-exact core not found: {source_core}')

    t0 = time.perf_counter()
    short_gains = f'/tmp/gpu_normalize_short_source_exact_{os.getpid()}.gains.f32'
    cmd = [source_core, args.input_f32, args.output_f32, str(args.rate), str(args.channels), short_gains, str(args.target_i), str(args.target_lra), str(args.target_tp)]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    source_text = proc.stdout + proc.stderr
    try:
        os.unlink(short_gains)
    except FileNotFoundError:
        pass

    elapsed = time.perf_counter() - t0
    if proc.returncode != 0:
        sys.stderr.write(source_text)
        raise SystemExit(proc.returncode)

    input_match = re.search(r'input_i=([-+0-9.]+)', source_text)
    if args.max_gain_db > 0:
        if not input_match:
            sys.stderr.write(source_text)
            print('GPU normalize: missing input_i in short source metrics', file=sys.stderr)
            raise SystemExit(43)
        input_i = float(input_match.group(1))
        gain_needed = args.target_i - input_i
        print(f'input_i={input_i:.2f} gain_needed={gain_needed:.2f} max_gain_db={args.max_gain_db:.2f}', file=sys.stderr)
        if gain_needed > args.max_gain_db:
            print('GPU normalize gain gate exceeded', file=sys.stderr)
            raise SystemExit(42)

    if args.dump_window_gains:
        open(args.dump_window_gains, 'wb').close()

    print(f'gpu=short_source_exact_cpu_core', file=sys.stderr)
    print(f'audio_seconds={cfg.seconds:.3f} rate={args.rate} channels={args.channels} windows={cfg.windows} pcm_mib={cfg.mib:.1f} chunk_mib=0.0', file=sys.stderr)
    print(f'target_i={args.target_i:.2f} target_lra={args.target_lra:.2f} target_tp={args.target_tp:.2f} effective_tp={args.target_tp:.2f} max_gain_db={args.max_gain_db:.2f}', file=sys.stderr)
    print(f'planner=short_source_exact_cpu_core elapsed_sec={elapsed:.3f} realtime_x={cfg.seconds / elapsed if elapsed > 0 else 0:.1f}', file=sys.stderr)
    print(f'profile_stage name=short_source_exact_cpu_core wall_sec={elapsed:.6f}', file=sys.stderr)
    emit_progress('short_source_exact', 1.0)
    return True
