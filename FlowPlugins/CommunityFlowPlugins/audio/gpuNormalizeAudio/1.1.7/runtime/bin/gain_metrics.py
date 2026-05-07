from __future__ import annotations

import array
import ctypes
from dataclasses import dataclass
import math
import sys
import time

from cuda_driver import chk
from cuda_launch import launch_timed_kernel
import kernel_args
from limiter_risk import build_prelimiter_risk_map
from loudnorm_math import input_loudness_from_window_sums
from runtime_profile import format_profile_stage


@dataclass
class GainMetricsResult:
    input_i: float
    gain_min_amp: float
    gain_max_amp: float
    gain_wall_time: float = 0.0
    gain_kernel_time: float = 0.0
    metrics_wall_time: float = 0.0
    metrics_kernel_time: float = 0.0
    metrics_d2h_time: float = 0.0
    metrics_path: str = 'host_full_arrays'
    copied_full_sums: int = 0
    copied_full_gains: int = 0
    total_d2h_time: float = 0.0
    prelimiter_unsafe_flags: list[int] | None = None


def run_gain_metrics(cuda, args, *, cfg, buffers, kernels, bindings, emit_progress):
    windows = cfg.windows
    frames_per_window = cfg.frames_per_window
    d_sums = buffers.d_sums
    d_gains = buffers.d_gains
    d_gains_next = buffers.d_gains_next
    d_peaks = buffers.d_peaks
    d_metrics = buffers.d_metrics
    gain_fn = kernels.gain_fn
    metrics_fn = kernels.metrics_fn
    has_metrics_kernel = kernels.has_metrics_kernel
    sums_arg = bindings.sums_arg
    peaks_arg = bindings.peaks_arg
    gains_arg = bindings.gains_arg
    gains_next_arg = bindings.gains_next_arg
    windows_arg = bindings.windows_arg
    frame_window_arg = bindings.frame_window_arg
    target_i_arg = bindings.target_i_arg
    target_lra_arg = bindings.target_lra_arg
    target_tp_arg = bindings.target_tp_arg
    hist_energies_arg = bindings.hist_energies_arg
    hist_boundaries_arg = bindings.hist_boundaries_arg
    measured_i_arg = bindings.measured_i_arg
    measured_thresh_arg = bindings.measured_thresh_arg
    offset_db_arg = bindings.offset_db_arg
    linear_mode_arg = bindings.linear_mode_arg
    metrics_arg = bindings.metrics_arg
    result = GainMetricsResult(input_i=float('nan'), gain_min_amp=1.0, gain_max_amp=1.0)
    gain_args = kernel_args.build_gain_args(sums_arg, peaks_arg, gains_arg, gains_next_arg, windows_arg, frame_window_arg, target_i_arg, target_lra_arg, target_tp_arg, hist_energies_arg, hist_boundaries_arg, measured_i_arg, measured_thresh_arg, offset_db_arg, linear_mode_arg)

    if has_metrics_kernel:
        gain_t0 = time.perf_counter()
        result.gain_kernel_time = launch_timed_kernel(cuda, 'source-port-gain', gain_fn, gain_args)
        result.gain_wall_time = time.perf_counter() - gain_t0
        emit_progress('gain_plan', 0.75)

        metrics_args = kernel_args.build_metrics_args(sums_arg, gains_arg, metrics_arg, windows_arg, frame_window_arg, hist_energies_arg, hist_boundaries_arg)
        metrics = array.array('f', [0.0, 0.0, 0.0])
        metrics_t0 = time.perf_counter()
        result.metrics_kernel_time = launch_timed_kernel(cuda, 'source-port-metrics', metrics_fn, metrics_args)
        copy_t0 = time.perf_counter()
        chk(cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(metrics.buffer_info()[0]), d_metrics, 3 * 4), 'cuMemcpyDtoH(metrics)')
        result.metrics_d2h_time = time.perf_counter() - copy_t0
        result.total_d2h_time += result.metrics_d2h_time
        result.metrics_wall_time = time.perf_counter() - metrics_t0
        result.metrics_path = 'device_tiny_metrics'
        result.input_i = float(metrics[0])
        result.gain_min_amp = max(0.0, float(metrics[1]))
        result.gain_max_amp = max(0.0, float(metrics[2]))
    else:
        result.copied_full_sums = 1
        copy_t0 = time.perf_counter()
        window_sums = array.array('d', [0.0]) * windows
        chk(cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(window_sums.buffer_info()[0]), d_sums, windows * 8), 'cuMemcpyDtoH(sums)')
        copy_dt = time.perf_counter() - copy_t0
        result.metrics_d2h_time += copy_dt
        result.metrics_wall_time += copy_dt
        result.total_d2h_time += copy_dt
        result.input_i = input_loudness_from_window_sums(window_sums, frames_per_window)

        gain_t0 = time.perf_counter()
        result.gain_kernel_time = launch_timed_kernel(cuda, 'source-port-gain', gain_fn, gain_args)
        result.gain_wall_time = time.perf_counter() - gain_t0
        emit_progress('gain_plan', 0.75)

        result.copied_full_gains = 1
        copy_t0 = time.perf_counter()
        gains = array.array('f', [0.0]) * windows
        chk(cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(gains.buffer_info()[0]), d_gains, windows * 4), 'cuMemcpyDtoH(gains)')
        copy_dt = time.perf_counter() - copy_t0
        result.metrics_d2h_time += copy_dt
        result.metrics_wall_time += copy_dt
        result.total_d2h_time += copy_dt
        result.gain_min_amp = min(gains) if gains else 1.0
        result.gain_max_amp = max(gains) if gains else 1.0

    if cfg.has_measured:
        result.input_i = args.measured_i
    gain_needed = args.target_i - result.input_i if math.isfinite(result.input_i) else float('inf')
    print(f'input_i={result.input_i:.2f} gain_needed={gain_needed:.2f} max_gain_db={args.max_gain_db:.2f}', file=sys.stderr)
    if args.max_gain_db > 0 and gain_needed > args.max_gain_db:
        print('GPU normalize gain gate exceeded', file=sys.stderr)
        raise SystemExit(42)

    if args.dump_window_gains:
        result.copied_full_gains = 1
        gains = array.array('f', [0.0]) * windows
        copy_t0 = time.perf_counter()
        chk(cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(gains.buffer_info()[0]), d_gains, windows * 4), 'cuMemcpyDtoH(gains dump)')
        copy_dt = time.perf_counter() - copy_t0
        result.metrics_d2h_time += copy_dt
        result.metrics_wall_time += copy_dt
        result.total_d2h_time += copy_dt
        result.gain_min_amp = min(gains) if gains else 1.0
        result.gain_max_amp = max(gains) if gains else 1.0
        with open(args.dump_window_gains, 'wb') as gain_fh:
            gains.tofile(gain_fh)

    if args.dump_window_gains_next:
        result.copied_full_gains = 1
        gains_next = array.array('f', [0.0]) * windows
        copy_t0 = time.perf_counter()
        chk(cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(gains_next.buffer_info()[0]), d_gains_next, windows * 4), 'cuMemcpyDtoH(gains_next dump)')
        copy_dt = time.perf_counter() - copy_t0
        result.metrics_d2h_time += copy_dt
        result.metrics_wall_time += copy_dt
        result.total_d2h_time += copy_dt
        with open(args.dump_window_gains_next, 'wb') as gain_fh:
            gains_next.tofile(gain_fh)

    if cfg.exact_limiter_requested:
        peak_bits_host = array.array('I', [0]) * windows
        gains_host = array.array('f', [0.0]) * windows
        gains_next_host = array.array('f', [0.0]) * windows
        copy_t0 = time.perf_counter()
        chk(cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(peak_bits_host.buffer_info()[0]), d_peaks, windows * 4), 'cuMemcpyDtoH(prelimiter peaks)')
        chk(cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(gains_host.buffer_info()[0]), d_gains, windows * 4), 'cuMemcpyDtoH(prelimiter gains)')
        chk(cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(gains_next_host.buffer_info()[0]), d_gains_next, windows * 4), 'cuMemcpyDtoH(prelimiter gains_next)')
        copy_dt = time.perf_counter() - copy_t0
        result.total_d2h_time += copy_dt
        result.metrics_d2h_time += copy_dt
        result.metrics_wall_time += copy_dt
        result.prelimiter_unsafe_flags, risk_stats = build_prelimiter_risk_map(
            peak_bits_host,
            gains_host,
            gains_next_host,
            windows,
            cfg.ceiling,
            cfg.exact_risk_expand_before_windows,
            cfg.exact_risk_expand_after_windows,
        )
        print(format_profile_stage('prelimiter_risk_map', [
            ('windows', windows),
            ('unsafe_windows', risk_stats['unsafe_windows']),
            ('unsafe_fraction', f'{risk_stats["unsafe_fraction"]:.6f}'),
            ('risk_expand_windows', cfg.exact_risk_expand_windows),
            ('risk_expand_before_windows', risk_stats['risk_expand_before_windows']),
            ('risk_expand_after_windows', risk_stats['risk_expand_after_windows']),
            ('flagged_windows', risk_stats['flagged_windows']),
            ('flagged_fraction', f'{risk_stats["flagged_fraction"]:.6f}'),
            ('flagged_islands', risk_stats['flagged_islands']),
            ('longest_flagged_run', risk_stats['longest_flagged_run']),
            ('longest_safe_run', risk_stats['longest_safe_run']),
            ('first_unsafe_window', risk_stats['first_unsafe']),
            ('last_unsafe_window', risk_stats['last_unsafe']),
            ('max_pre_peak', f'{risk_stats["max_pre_peak"]:.9f}'),
            ('ceiling', f'{cfg.ceiling:.9f}'),
            ('copy_sec', f'{copy_dt:.6f}'),
        ]), file=sys.stderr)

    return result
