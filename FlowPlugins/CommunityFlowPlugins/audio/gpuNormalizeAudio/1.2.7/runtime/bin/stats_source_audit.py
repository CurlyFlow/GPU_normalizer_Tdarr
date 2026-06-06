from __future__ import annotations

import array
import ctypes
import math
import struct
import sys
import time

from cuda_driver import chk
from cuda_launch import launch_timed_kernel
import kernel_args
from loudnorm_math import input_loudness_range_from_window_sums, input_loudness_threshold_from_window_sums
from runtime_profile import format_profile_stage


def _audit_ffmpeg_input_metrics(ctx, result, tail_stage):
    cfg = ctx.cfg
    args = ctx.args
    if not (cfg.audit_ffmpeg_input_metrics or cfg.emit_first_pass_json) or not ctx.kernels.exact_sums_fn.value or not ctx.buffers.d_input_metric_audit_sums.value:
        return
    available_frames = len(tail_stage) // cfg.frame_bytes
    replay_frames = min(cfg.audit_input_replay_frames, available_frames)
    if replay_frames <= 0 or result.windows <= 0:
        return
    replay_bytes = replay_frames * cfg.frame_bytes
    replay_start = len(tail_stage) - replay_bytes
    source_partial_frames = result.total_frames % cfg.frames_per_window
    source_full_windows = result.total_frames // cfg.frames_per_window
    audit_windows = max(1, (source_partial_frames + replay_frames + cfg.frames_per_window - 1) // cfg.frames_per_window)
    audit_t0 = time.perf_counter()

    state_i = array.array('I', [0]) * 8
    state_d = array.array('d', [0.0]) * (args.channels * 4 + 1)
    final_states = getattr(ctx.cfg, '_ffmpeg_input_metric_final_states', None)
    if final_states is None:
        final_states = array.array('d', [0.0]) * (args.channels * 4)
        chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(final_states.buffer_info()[0]), ctx.buffers.d_start_states, len(final_states) * 8), 'cuMemcpyDtoH(input metric final states)')
    source_sums = array.array('d', [0.0]) * result.windows
    peak_bits = array.array('I', [0]) * result.windows
    d2h_t0 = time.perf_counter()
    chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(source_sums.buffer_info()[0]), ctx.buffers.d_sums, len(source_sums) * 8), 'cuMemcpyDtoH(input metric source sums)')
    chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(peak_bits.buffer_info()[0]), ctx.buffers.d_peaks, len(peak_bits) * 4), 'cuMemcpyDtoH(input metric peaks)')
    source_d2h_dt = time.perf_counter() - d2h_t0

    state_i[1] = source_partial_frames
    state_d[:len(final_states)] = final_states
    if source_partial_frames > 0 and source_full_windows < len(source_sums):
        state_d[(args.channels * 4)] = source_sums[source_full_windows]
    chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_exact_sums_state_i, ctypes.c_void_p(state_i.buffer_info()[0]), len(state_i) * 4), 'cuMemcpyHtoD(input metric audit state_i)')
    chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_exact_sums_state_d, ctypes.c_void_p(state_d.buffer_info()[0]), len(state_d) * 8), 'cuMemcpyHtoD(input metric audit state_d)')
    chk(ctx.cuda.cuMemsetD32_v2(ctx.buffers.d_input_metric_audit_sums, 0, audit_windows * 2), 'cuMemsetD32(input metric audit sums)')

    copied = 0
    kernel_dt = 0.0
    copy_dt = 0.0
    max_stage_bytes = (len(ctx.host_io.host_in) // cfg.frame_bytes) * cfg.frame_bytes
    while copied < replay_bytes:
        stage_bytes = min(max_stage_bytes, replay_bytes - copied)
        if stage_bytes <= 0:
            break
        memoryview(ctx.host_io.host_in)[:stage_bytes] = memoryview(tail_stage)[replay_start + copied:replay_start + copied + stage_bytes]
        copy_t0 = time.perf_counter()
        chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_in, ctypes.c_void_p(ctx.host_io.host_in_ptr), stage_bytes), 'cuMemcpyHtoD(input metric replay)')
        copy_dt += time.perf_counter() - copy_t0
        frames_arg = ctypes.c_uint32(stage_bytes // cfg.frame_bytes)
        sums_arg = ctypes.c_uint64(ctx.buffers.d_input_metric_audit_sums.value)
        exact_args = kernel_args.build_exact_sums_args(
            ctx.bindings.in_arg,
            sums_arg,
            ctx.bindings.exact_sums_state_i_arg,
            ctx.bindings.exact_sums_state_d_arg,
            frames_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.b_arg,
            ctx.bindings.a_arg,
        )
        kernel_dt += launch_timed_kernel(ctx.cuda, 'input-metric-replay-sums', ctx.kernels.exact_sums_fn, exact_args)
        copied += stage_bytes

    replay_sums = array.array('d', [0.0]) * audit_windows
    d2h_t0 = time.perf_counter()
    chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(replay_sums.buffer_info()[0]), ctx.buffers.d_input_metric_audit_sums, len(replay_sums) * 8), 'cuMemcpyDtoH(input metric replay sums)')
    d2h_dt = source_d2h_dt + (time.perf_counter() - d2h_t0)
    source_i, source_thresh = input_loudness_threshold_from_window_sums(source_sums, cfg.frames_per_window)
    source_lra = input_loudness_range_from_window_sums(source_sums, cfg.frames_per_window)
    replay_complete_windows = (source_partial_frames + replay_frames) // cfg.frames_per_window
    source_keep_windows = source_full_windows if source_partial_frames > 0 else result.windows
    augmented = array.array('d', source_sums[:source_keep_windows])
    augmented.extend(replay_sums[:replay_complete_windows])
    replay_i, replay_thresh = input_loudness_threshold_from_window_sums(augmented, cfg.frames_per_window)
    replay_lra = input_loudness_range_from_window_sums(augmented, cfg.frames_per_window)
    peak_amp = max((struct.unpack('f', struct.pack('I', bits))[0] for bits in peak_bits), default=0.0)
    input_tp = 20.0 * math.log10(peak_amp) if peak_amp > 0.0 else -float('inf')
    ctx.cfg._ffmpeg_input_metric_values = {
        'source_i': source_i,
        'source_thresh': source_thresh,
        'source_lra': source_lra,
        'replay_i': replay_i,
        'replay_thresh': replay_thresh,
        'replay_lra': replay_lra,
        'input_tp': input_tp,
        'replay_frames': replay_frames,
        'replay_windows': audit_windows,
        'replay_complete_windows': replay_complete_windows,
        'source_partial_frames': source_partial_frames,
    }
    if not cfg.audit_ffmpeg_input_metrics:
        return
    cpu_i = args.measured_i if cfg.has_measured else float('nan')
    cpu_thresh = args.measured_thresh if cfg.has_measured else float('nan')
    cpu_lra = args.measured_lra if cfg.has_measured else float('nan')
    cpu_tp = args.measured_tp if cfg.has_measured else float('nan')
    print(format_profile_stage('ffmpeg_input_metric_audit', [
        ('source_i', f'{source_i:.6f}'),
        ('source_thresh', f'{source_thresh:.6f}'),
        ('source_lra', f'{source_lra:.6f}'),
        ('replay_i', f'{replay_i:.6f}'),
        ('replay_thresh', f'{replay_thresh:.6f}'),
        ('replay_lra', f'{replay_lra:.6f}'),
        ('input_tp', f'{input_tp:.6f}'),
        ('cpu_i', f'{cpu_i:.6f}'),
        ('cpu_thresh', f'{cpu_thresh:.6f}'),
        ('cpu_lra', f'{cpu_lra:.6f}'),
        ('cpu_tp', f'{cpu_tp:.6f}'),
        ('diff_i', f'{(replay_i - cpu_i):.6f}'),
        ('diff_thresh', f'{(replay_thresh - cpu_thresh):.6f}'),
        ('diff_lra', f'{(replay_lra - cpu_lra):.6f}'),
        ('diff_tp', f'{(input_tp - cpu_tp):.6f}'),
        ('replay_frames', replay_frames),
        ('replay_windows', audit_windows),
        ('replay_complete_windows', replay_complete_windows),
        ('source_partial_frames', source_partial_frames),
        ('copy_sec', f'{copy_dt:.6f}'),
        ('kernel_sec', f'{kernel_dt:.6f}'),
        ('d2h_sec', f'{d2h_dt:.6f}'),
        ('wall_sec', f'{(time.perf_counter() - audit_t0):.6f}'),
    ]), file=sys.stderr)


def _copy_source_sums_slice(ctx, ptr, start_window, count, label):
    values = array.array('d', [0.0]) * (count * 3)
    if count <= 0:
        return values, 0.0
    offset = start_window * 3 * 8
    t0 = time.perf_counter()
    chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(values.buffer_info()[0]), ctypes.c_void_p(ptr.value + offset), len(values) * 8), label)
    return values, time.perf_counter() - t0


def _audit_source_sums_stage(ctx, result, start_window, count):
    if count <= 0:
        return
    exact_ptr = ctx.buffers.d_source_exact_audit_sums if ctx.cfg.source_block_sums else ctx.buffers.d_source_exact_sums
    candidate_ptr = ctx.buffers.d_source_exact_sums if ctx.cfg.source_block_sums else ctx.buffers.d_source_exact_audit_sums
    exact, exact_dt = _copy_source_sums_slice(ctx, exact_ptr, start_window, count, 'cuMemcpyDtoH(source exact audit)')
    candidate, candidate_dt = _copy_source_sums_slice(ctx, candidate_ptr, start_window, count, 'cuMemcpyDtoH(source block audit)')
    result.total_d2h_time += exact_dt + candidate_dt

    state = getattr(ctx.cfg, '_source_sum_audit_state', None)
    if state is None:
        state = {
            'windows': 0,
            'diffs': 0,
            'max_abs': 0.0,
            'max_rel': 0.0,
            'max_window': -1,
            'max_slot': -1,
            'max_exact': 0.0,
            'max_candidate': 0.0,
            'first_window': -1,
            'first_slot': -1,
            'first_exact': 0.0,
            'first_candidate': 0.0,
        }
        ctx.cfg._source_sum_audit_state = state

    state['windows'] += count
    for i, exact_value in enumerate(exact):
        candidate_value = candidate[i]
        if exact_value == candidate_value:
            continue
        window = start_window + (i // 3)
        slot = i % 3
        abs_diff = abs(candidate_value - exact_value)
        rel_diff = abs_diff / max(abs(exact_value), 1e-300)
        state['diffs'] += 1
        if state['first_window'] < 0:
            state['first_window'] = window
            state['first_slot'] = slot
            state['first_exact'] = exact_value
            state['first_candidate'] = candidate_value
        if abs_diff > state['max_abs']:
            state['max_abs'] = abs_diff
            state['max_rel'] = rel_diff
            state['max_window'] = window
            state['max_slot'] = slot
            state['max_exact'] = exact_value
            state['max_candidate'] = candidate_value


def _finish_source_sum_audit(ctx):
    if not ctx.cfg.source_sum_audit:
        return
    state = getattr(ctx.cfg, '_source_sum_audit_state', None)
    if state is None:
        return
    print(
        'source_sum_audit '
        f'candidate=block frames={ctx.cfg.source_block_frames} '
        f'output_candidate={1 if ctx.cfg.source_block_sums else 0} '
        f'windows={state["windows"]} diffs={state["diffs"]} '
        f'max_abs={state["max_abs"]:.17g} max_rel={state["max_rel"]:.17g} '
        f'max_window={state["max_window"]} max_slot={state["max_slot"]} '
        f'max_exact={state["max_exact"]:.17g} max_candidate={state["max_candidate"]:.17g} '
        f'first_window={state["first_window"]} first_slot={state["first_slot"]} '
        f'first_exact={state["first_exact"]:.17g} first_candidate={state["first_candidate"]:.17g}',
        file=sys.stderr,
    )
