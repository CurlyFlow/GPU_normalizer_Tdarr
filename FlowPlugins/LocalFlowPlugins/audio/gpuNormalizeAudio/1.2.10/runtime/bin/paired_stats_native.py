from __future__ import annotations

import array
from dataclasses import dataclass
import ctypes
import time

from cuda_driver import chk
from stats_channel_pipeline import create_source_stage_config
from stats_channel_native import _array_ptr, _copy_filter_coeffs, _load_native_lib, native_channel_stats_supported
from stats_q_sums import combine_channel_sums


@dataclass
class _NativeStatsState:
    lib: object
    channel_sums: array.array
    peaks: array.array
    states: array.array
    source_start_states: array.array | None
    b_coeffs: array.array
    a_coeffs: array.array
    channel_sums_ptr: object
    peaks_ptr: object
    states_ptr: object
    source_states_ptr: object
    b_ptr: object
    a_ptr: object


def _native_state_for(runner):
    ctx = runner.ctx
    channels = ctx.args.channels
    result = runner.result
    channel_sums = array.array('d', [0.0]) * (result.windows * channels)
    peaks = array.array('I', [0]) * result.windows
    states = array.array('d', [0.0]) * (channels * 4)
    source_start_states = array.array('d', [0.0]) * (result.windows * channels * 4) if ctx.buffers.d_source_start_states.value else None
    b_coeffs, a_coeffs = _copy_filter_coeffs(ctx)
    return _NativeStatsState(
        lib=_load_native_lib(),
        channel_sums=channel_sums,
        peaks=peaks,
        states=states,
        source_start_states=source_start_states,
        b_coeffs=b_coeffs,
        a_coeffs=a_coeffs,
        channel_sums_ptr=_array_ptr(channel_sums, ctypes.c_double),
        peaks_ptr=_array_ptr(peaks, ctypes.c_uint32),
        states_ptr=_array_ptr(states, ctypes.c_double),
        source_states_ptr=_array_ptr(source_start_states, ctypes.c_double) if source_start_states is not None else ctypes.POINTER(ctypes.c_double)(),
        b_ptr=_array_ptr(b_coeffs, ctypes.c_double),
        a_ptr=_array_ptr(a_coeffs, ctypes.c_double),
    )


def _copy_native_source_start_states(runner, native, ready_windows):
    if native.source_start_states is None or ready_windows <= 0:
        return
    ctx = runner.ctx
    copy_bytes = ready_windows * ctx.args.channels * 4 * 8
    copy_t0 = time.perf_counter()
    chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_source_start_states, ctypes.c_void_p(native.source_start_states.buffer_info()[0]), copy_bytes), f'cuMemcpyHtoD({runner.label} paired native source_start_states)')
    copy_dt = time.perf_counter() - copy_t0
    runner.result.stats_sums_h2d_time += copy_dt
    runner.result.total_h2d_time += copy_dt


def _append_native_source_stage(runner, chunk, chunks, native):
    ctx = runner.ctx
    cfg = ctx.cfg
    result = runner.result
    if runner.source_stage is None:
        return
    stage_frames = len(runner.source_stage) // cfg.sizing.frame_bytes
    stage_end_frame = runner.source_stage_start_frame + stage_frames
    full_ready_windows = min(result.windows, stage_end_frame // cfg.input_shape.frames_per_window)
    source_overlap_frames = cfg.input_shape.frames_per_window * 29
    while full_ready_windows - runner.next_source_window >= cfg.sizing.source_precompute_windows:
        ready_windows = runner.next_source_window + cfg.sizing.source_precompute_windows
        _copy_native_source_start_states(runner, native, ready_windows)
        runner.next_source_window = runner.source_precompute.run_stage(
            runner.source_stage,
            runner.source_stage_start_frame,
            runner.next_source_window,
            ready_windows,
        )
        ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.input_shape.nbytes)))
        runner.source_stage_start_frame = runner.source_precompute.trim_exact_stage(
            runner.source_stage,
            runner.source_stage_start_frame,
            runner.next_source_window,
            source_overlap_frames,
            cfg.sizing.frame_bytes,
            cfg.input_shape.frames_per_window,
        )


def _process_native_combined_runner(runner, native, chunk, chunks, *, combined_host_ptr, input_channels, channel_offset):
    ctx = runner.ctx
    cfg = ctx.cfg
    channels = ctx.args.channels
    compact_ptr = ctypes.POINTER(ctypes.c_double)()
    if runner.source_stage is not None:
        out_bytes = chunk.this_frames * cfg.sizing.frame_bytes
        old_len = len(runner.source_stage)
        runner.source_stage.extend(b'\0' * out_bytes)
        compact_ptr = ctypes.cast(ctypes.byref(ctypes.c_char.from_buffer(runner.source_stage), old_len), ctypes.POINTER(ctypes.c_double))
    stage_t0 = time.perf_counter()
    code = native.lib.opx_loudnorm_channel_stats_f64_process_offset(
        ctypes.cast(ctypes.c_void_p(combined_host_ptr), ctypes.POINTER(ctypes.c_double)),
        ctypes.c_uint32(chunk.this_frames),
        ctypes.c_uint32(channels),
        ctypes.c_uint32(input_channels),
        ctypes.c_uint32(channel_offset),
        ctypes.c_uint32(cfg.input_shape.frames_per_window),
        ctypes.c_uint32(chunk.frame_offset),
        native.channel_sums_ptr,
        native.peaks_ptr,
        native.states_ptr,
        native.source_states_ptr,
        native.b_ptr,
        native.a_ptr,
        compact_ptr,
    )
    native_dt = time.perf_counter() - stage_t0
    if code != 0:
        raise RuntimeError(f'{runner.label} paired native channel stats failed with code {code}')
    runner.result.stats_sums_kernel_time += native_dt
    runner.result.stats_sums_wall_time += native_dt
    _append_native_source_stage(runner, chunk, chunks, native)
    ctx.emit_progress('stats_sums', 0.70 * (((chunk.frame_offset + chunk.this_frames) * cfg.sizing.frame_bytes) / float(cfg.input_shape.nbytes)))
    runner.chunk_index += 1


def _finish_native_runner(runner, native, done_frames):
    ctx = runner.ctx
    cfg = ctx.cfg
    result = runner.result
    if cfg.root.streaming_io:
        runner.source_precompute.apply_streaming_size_update(done_frames * cfg.sizing.frame_bytes)
    if runner.source_stage is not None:
        if result.windows > runner.next_source_window:
            _copy_native_source_start_states(runner, native, result.windows)
            runner.next_source_window = runner.source_precompute.run_stage(
                runner.source_stage,
                runner.source_stage_start_frame,
                runner.next_source_window,
                result.windows,
            )
        if runner.next_source_window != result.windows:
            raise RuntimeError(f'paired native source exact precompute incomplete for {runner.label}: windows={runner.next_source_window} expected={result.windows}')
        runner.source_precompute.finish_source_sum_audit()
    copy_t0 = time.perf_counter()
    chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_start_states, ctypes.c_void_p(native.channel_sums.buffer_info()[0]), len(native.channel_sums) * 8), f'cuMemcpyHtoD({runner.label} paired native channel_sums)')
    chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_peaks, ctypes.c_void_p(native.peaks.buffer_info()[0]), len(native.peaks) * 4), f'cuMemcpyHtoD({runner.label} paired native peaks)')
    if native.source_start_states is not None:
        chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_source_start_states, ctypes.c_void_p(native.source_start_states.buffer_info()[0]), len(native.source_start_states) * 8), f'cuMemcpyHtoD({runner.label} paired native source_start_states)')
    copy_dt = time.perf_counter() - copy_t0
    result.stats_sums_h2d_time += copy_dt
    result.total_h2d_time += copy_dt
    combine_channel_sums(ctx, result, source_arg=ctx.bindings.start_states_arg, label=f'{runner.label}-combine-native-channel-sums')
    runner.source_precompute.run_pass()
    ctx.emit_progress('stats_sums', 0.70)


def _can_use_paired_native_combined(primary, partner):
    for runner in (primary, partner):
        if runner.audit_tail is not None:
            raise RuntimeError('paired native stats does not support first-pass/audit tails')
        if not native_channel_stats_supported(runner.ctx, create_source_stage_config(runner.ctx.cfg)):
            return False
    return True
