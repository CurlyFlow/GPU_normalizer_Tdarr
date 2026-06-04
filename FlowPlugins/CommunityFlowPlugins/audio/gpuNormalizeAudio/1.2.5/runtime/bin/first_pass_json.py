from __future__ import annotations

import array
import ctypes
import json
import math
import struct
import sys
import time

from cuda_driver import chk
from loudnorm_math import input_loudness_range_from_window_sums, input_loudness_threshold_from_window_sums
from runtime_profile import format_profile_stage


def _copy_device_array(cuda, ptr, typecode, count, label):
    values = array.array(typecode, [0]) * count
    if count:
        chk(cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(values.buffer_info()[0]), ptr, values.itemsize * count), f'cuMemcpyDtoH({label})')
    return values


def _tp_from_peak_bits(peak_bits):
    peak_amp = max((struct.unpack('f', struct.pack('I', bits))[0] for bits in peak_bits), default=0.0)
    return 20.0 * math.log10(peak_amp) if peak_amp > 0.0 else -float('inf')


def _fmt(value):
    if not math.isfinite(value):
        return '-inf' if value < 0 else 'inf'
    return f'{value:.2f}'


def emit_first_pass_json(cuda, args, cfg, buffers, apply_result):
    if not cfg.emit_first_pass_json:
        return None
    t0 = time.perf_counter()
    input_metrics = getattr(cfg, '_ffmpeg_input_metric_values', None)
    d2h_t0 = time.perf_counter()
    output_sums = _copy_device_array(cuda, buffers.d_channel_sums, 'd', cfg.windows, 'first-pass output sums')
    if input_metrics is None:
        input_sums = _copy_device_array(cuda, buffers.d_sums, 'd', cfg.windows, 'first-pass input sums')
        peak_bits = _copy_device_array(cuda, buffers.d_peaks, 'I', cfg.windows, 'first-pass input peaks')
    else:
        input_sums = None
        peak_bits = None
    d2h_dt = time.perf_counter() - d2h_t0

    if input_metrics is None:
        input_i, input_thresh = input_loudness_threshold_from_window_sums(input_sums, cfg.frames_per_window)
        input_lra = input_loudness_range_from_window_sums(input_sums, cfg.frames_per_window)
        input_tp = _tp_from_peak_bits(peak_bits)
        input_metric_source = 'source'
    else:
        input_i = input_metrics['replay_i']
        input_thresh = input_metrics['replay_thresh']
        input_lra = input_metrics['replay_lra']
        input_tp = input_metrics['input_tp']
        input_metric_source = 'replay'

    output_i, output_thresh = input_loudness_threshold_from_window_sums(output_sums, cfg.frames_per_window)
    output_lra = input_loudness_range_from_window_sums(output_sums, cfg.frames_per_window)
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
        ('input_i', f'{input_i:.6f}'),
        ('input_thresh', f'{input_thresh:.6f}'),
        ('input_lra', f'{input_lra:.6f}'),
        ('input_tp', f'{input_tp:.6f}'),
        ('replay_i', f"{input_metrics['replay_i']:.6f}" if input_metrics is not None else 'nan'),
        ('replay_thresh', f"{input_metrics['replay_thresh']:.6f}" if input_metrics is not None else 'nan'),
        ('replay_lra', f"{input_metrics['replay_lra']:.6f}" if input_metrics is not None else 'nan'),
        ('output_i', f'{output_i:.6f}'),
        ('output_thresh', f'{output_thresh:.6f}'),
        ('output_lra', f'{output_lra:.6f}'),
        ('output_offset_db', f'{target_offset:.6f}'),
        ('output_metric_kernel_sec', f'{apply_result.first_pass_output_metric_kernel_time:.6f}'),
        ('d2h_sec', f'{d2h_dt:.6f}'),
        ('wall_sec', f'{(time.perf_counter() - t0):.6f}'),
    ]), file=sys.stderr)
    return values
