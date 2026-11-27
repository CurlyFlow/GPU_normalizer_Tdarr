import json
import math
import sys
import time

from cuda_driver import copy_device_array
from first_pass_json_metrics import (
    _first_pass_output_sums,
    _full_windows_for_first_pass,
    _output_loudness_from_sums,
    _output_metric_audit_fields,
    _tp_from_peak_bits,
)
from loudnorm_math import input_loudness_range_from_window_sums, input_loudness_threshold_from_window_sums
from runtime_env import env_float
from runtime_profile import format_profile_stage


def _fmt(value):
    if not math.isfinite(value):
        return '-inf' if value < 0 else 'inf'
    return f'{value:.2f}'


def emit_first_pass_json(cuda, args, cfg, buffers, apply_result):
    if not cfg.exact.emit_first_pass_json:
        return None
    t0 = time.perf_counter()
    input_metrics = getattr(cfg, '_ffmpeg_input_metric_values', None)
    d2h_t0 = time.perf_counter()
    output_sums, output_metric_source = _first_pass_output_sums(cuda, cfg, buffers)
    if input_metrics is None:
        input_sums = copy_device_array(cuda, buffers.d_sums, 'd', cfg.input_shape.windows, 'first-pass input sums')
        peak_bits = copy_device_array(cuda, buffers.d_peaks, 'I', cfg.input_shape.windows, 'first-pass input peaks')
    else:
        input_sums = None
        peak_bits = None
    d2h_dt = time.perf_counter() - d2h_t0

    full_windows = _full_windows_for_first_pass(cfg)
    if input_metrics is None:
        input_i, input_thresh = input_loudness_threshold_from_window_sums(input_sums, cfg.input_shape.frames_per_window, full_windows=full_windows)
        input_lra = input_loudness_range_from_window_sums(input_sums, cfg.input_shape.frames_per_window, full_windows=full_windows)
        input_tp = _tp_from_peak_bits(peak_bits)
        input_metric_source = 'source'
    else:
        input_i = input_metrics['replay_i']
        input_thresh = input_metrics['replay_thresh']
        input_lra = input_metrics['replay_lra']
        input_tp = input_metrics['input_tp']
        input_metric_source = 'replay'
    replay_input_bias_db = env_float('LOUDNORM_GPU_FIRST_PASS_REPLAY_INPUT_BIAS_DB', 0.0) if input_metrics is not None else 0.0
    if replay_input_bias_db:
        input_i += replay_input_bias_db
        input_thresh += replay_input_bias_db

    output_i, output_thresh, output_lra = _output_loudness_from_sums(output_sums, cfg, full_windows)
    audit_output_sums = getattr(cfg, '_first_pass_output_sums_host_audit', None)
    audit_output_sums_source = getattr(cfg, '_first_pass_output_sums_host_audit_source', 'host_audit')
    audit_fields = []
    if audit_output_sums is not None:
        audit_fields = _output_metric_audit_fields(output_sums, audit_output_sums, cfg, full_windows, output_i)
    target_offset = args.target_i - output_i
    values = {
        'input_i': _fmt(input_i),
        'input_tp': _fmt(input_tp),
        'input_lra': _fmt(input_lra),
        'input_thresh': _fmt(input_thresh),
        'output_i': _fmt(output_i),
        'output_tp': _fmt(args.target_tp),
        'output_lra': _fmt(output_lra),
        'output_thresh': _fmt(output_thresh),
        'normalization_type': 'dynamic',
        'target_offset': _fmt(target_offset),
    }
    print(json.dumps(values, indent=4), file=sys.stderr)
    print(format_profile_stage('first_pass_json', [
        ('input_metric_source', input_metric_source),
        ('output_metric_source', output_metric_source),
        ('audit_output_metric_source', audit_output_sums_source if audit_output_sums is not None else 'none'),
        ('full_windows', full_windows if full_windows is not None else -1),
        ('input_i', f'{input_i:.6f}'),
        ('input_thresh', f'{input_thresh:.6f}'),
        ('input_lra', f'{input_lra:.6f}'),
        ('input_tp', f'{input_tp:.6f}'),
        ('replay_input_bias_db', f'{replay_input_bias_db:.6f}'),
        ('replay_i', f"{input_metrics['replay_i']:.6f}" if input_metrics is not None else 'nan'),
        ('replay_thresh', f"{input_metrics['replay_thresh']:.6f}" if input_metrics is not None else 'nan'),
        ('replay_lra', f"{input_metrics['replay_lra']:.6f}" if input_metrics is not None else 'nan'),
        ('output_i', f'{output_i:.6f}'),
        ('output_thresh', f'{output_thresh:.6f}'),
        ('output_lra', f'{output_lra:.6f}'),
        ('output_offset_db', f'{target_offset:.6f}'),
        *audit_fields,
        ('output_metric_kernel_sec', f'{apply_result.first_pass_output_metric_kernel_time:.6f}'),
        ('d2h_sec', f'{d2h_dt:.6f}'),
        ('wall_sec', f'{(time.perf_counter() - t0):.6f}'),
    ]), file=sys.stderr)
    return values


def emit_first_pass_input_json(cuda, args, cfg, buffers):
    if not cfg.exact.emit_first_pass_json:
        return None
    t0 = time.perf_counter()
    input_metrics = getattr(cfg, '_ffmpeg_input_metric_values', None)
    d2h_t0 = time.perf_counter()
    if input_metrics is None:
        input_sums = copy_device_array(cuda, buffers.d_sums, 'd', cfg.input_shape.windows, 'first-pass input sums')
        peak_bits = copy_device_array(cuda, buffers.d_peaks, 'I', cfg.input_shape.windows, 'first-pass input peaks')
    else:
        input_sums = None
        peak_bits = None
    d2h_dt = time.perf_counter() - d2h_t0

    full_windows = _full_windows_for_first_pass(cfg)
    if input_metrics is None:
        input_i, input_thresh = input_loudness_threshold_from_window_sums(input_sums, cfg.input_shape.frames_per_window, full_windows=full_windows)
        input_lra = input_loudness_range_from_window_sums(input_sums, cfg.input_shape.frames_per_window, full_windows=full_windows)
        input_tp = _tp_from_peak_bits(peak_bits)
        input_metric_source = 'source'
    else:
        input_i = input_metrics['replay_i']
        input_thresh = input_metrics['replay_thresh']
        input_lra = input_metrics['replay_lra']
        input_tp = input_metrics['input_tp']
        input_metric_source = 'replay'

    values = {
        'input_i': _fmt(input_i),
        'input_tp': _fmt(input_tp),
        'input_lra': _fmt(input_lra),
        'input_thresh': _fmt(input_thresh),
        'output_i': '0.00',
        'output_tp': _fmt(args.target_tp),
        'output_lra': '0.00',
        'output_thresh': '0.00',
        'normalization_type': 'dynamic',
        'target_offset': '0.00',
    }
    print(json.dumps(values, indent=4), file=sys.stderr)
    print(format_profile_stage('first_pass_input_json', [
        ('input_metric_source', input_metric_source),
        ('full_windows', full_windows if full_windows is not None else -1),
        ('input_i', f'{input_i:.6f}'),
        ('input_thresh', f'{input_thresh:.6f}'),
        ('input_lra', f'{input_lra:.6f}'),
        ('input_tp', f'{input_tp:.6f}'),
        ('replay_i', f"{input_metrics['replay_i']:.6f}" if input_metrics is not None else 'nan'),
        ('replay_thresh', f"{input_metrics['replay_thresh']:.6f}" if input_metrics is not None else 'nan'),
        ('replay_lra', f"{input_metrics['replay_lra']:.6f}" if input_metrics is not None else 'nan'),
        ('d2h_sec', f'{d2h_dt:.6f}'),
        ('wall_sec', f'{(time.perf_counter() - t0):.6f}'),
    ]), file=sys.stderr)
    return values
