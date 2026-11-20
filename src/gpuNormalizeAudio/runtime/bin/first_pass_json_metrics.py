import math
import struct

from cuda_driver import copy_device_array
from loudnorm_math import input_loudness_range_from_window_sums, input_loudness_threshold_from_window_sums
from runtime_env import env_flag


def _tp_from_peak_bits(peak_bits):
    peak_amp = max((struct.unpack('f', struct.pack('I', bits))[0] for bits in peak_bits), default=0.0)
    return 20.0 * math.log10(peak_amp) if peak_amp > 0.0 else -float('inf')


def _full_windows_for_first_pass(cfg):
    if not env_flag('LOUDNORM_GPU_FIRST_PASS_FFMPEG_WINDOW_TRIM'):
        return None
    return cfg.input_shape.total_frames // cfg.input_shape.frames_per_window


def _first_pass_output_sums(cuda, cfg, buffers):
    output_sums = getattr(cfg, '_first_pass_output_sums_host', None)
    if output_sums is not None:
        return output_sums, getattr(cfg, '_first_pass_output_sums_host_source', 'host')
    device_source = getattr(cfg, '_first_pass_output_sums_device_source', 'device')
    return copy_device_array(cuda, buffers.d_channel_sums, 'd', cfg.input_shape.windows, 'first-pass output sums'), device_source


def _output_loudness_from_sums(output_sums, cfg, full_windows):
    output_i, output_thresh = input_loudness_threshold_from_window_sums(output_sums, cfg.input_shape.frames_per_window, full_windows=full_windows)
    output_lra = input_loudness_range_from_window_sums(output_sums, cfg.input_shape.frames_per_window, full_windows=full_windows)
    return output_i, output_thresh, output_lra


def _output_metric_audit_fields(output_sums, audit_output_sums, cfg, full_windows, output_i):
    audit_i, audit_thresh, audit_lra = _output_loudness_from_sums(audit_output_sums, cfg, full_windows)
    compare_windows = full_windows if full_windows is not None and full_windows >= 0 else min(len(output_sums), len(audit_output_sums))
    max_abs_delta = 0.0
    max_delta = 0.0
    max_abs_window = -1
    max_output_sum = 0.0
    max_audit_sum = 0.0
    audit_max_sum = 0.0
    audit_max_window = -1
    output_at_audit_max = 0.0
    sum_abs_delta = 0.0
    delta_count = 0
    first_delta_window = -1
    last_delta_window = -1
    delta_windows = []
    top_abs_deltas = []
    for idx in range(compare_windows):
        output_sum = float(output_sums[idx])
        audit_sum = float(audit_output_sums[idx])
        if audit_sum > audit_max_sum:
            audit_max_sum = audit_sum
            audit_max_window = idx
            output_at_audit_max = output_sum
        signed_delta = output_sum - audit_sum
        abs_delta = abs(signed_delta)
        sum_abs_delta += abs_delta
        if abs_delta > 1e-9:
            delta_count += 1
            if first_delta_window < 0:
                first_delta_window = idx
            last_delta_window = idx
            if len(delta_windows) < 64:
                delta_windows.append(str(idx))
            top_abs_deltas.append((abs_delta, idx, signed_delta, output_sum, audit_sum))
        if abs_delta > max_abs_delta:
            max_abs_delta = abs_delta
            max_delta = signed_delta
            max_abs_window = idx
            max_output_sum = output_sum
            max_audit_sum = audit_sum
    top_abs_deltas.sort(reverse=True)
    top_abs_delta_text = ','.join(
        f'{idx}:{signed_delta:.12e}:{output_sum:.12e}:{audit_sum:.12e}'
        for _, idx, signed_delta, output_sum, audit_sum in top_abs_deltas[:16]
    )
    return [
        ('audit_output_i', f'{audit_i:.6f}'),
        ('audit_output_thresh', f'{audit_thresh:.6f}'),
        ('audit_output_lra', f'{audit_lra:.6f}'),
        ('audit_delta_i', f'{(output_i - audit_i):.6f}'),
        ('audit_sum_max_abs_delta', f'{max_abs_delta:.12e}'),
        ('audit_sum_max_delta', f'{max_delta:.12e}'),
        ('audit_sum_max_abs_window', max_abs_window),
        ('audit_sum_output_at_max', f'{max_output_sum:.12e}'),
        ('audit_sum_native_at_max', f'{max_audit_sum:.12e}'),
        ('audit_sum_audit_max_window', audit_max_window),
        ('audit_sum_audit_max', f'{audit_max_sum:.12e}'),
        ('audit_sum_output_at_audit_max', f'{output_at_audit_max:.12e}'),
        ('audit_sum_delta_count', delta_count),
        ('audit_sum_first_delta_window', first_delta_window),
        ('audit_sum_last_delta_window', last_delta_window),
        ('audit_sum_delta_windows', ','.join(delta_windows) if delta_windows else '-'),
        ('audit_sum_top_abs_deltas', top_abs_delta_text if top_abs_delta_text else '-'),
        ('audit_sum_abs_delta', f'{sum_abs_delta:.12e}'),
    ]
