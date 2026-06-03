from __future__ import annotations

import array
from dataclasses import dataclass
import ctypes
import queue
from types import SimpleNamespace
import time

from cuda_driver import chk
from cuda_launch import launch_kernel, launch_timed_kernel
import kernel_args
from stats_channel_pipeline import create_source_stage_config, ensure_default_channel_stats_path
from stats_channel_native import _array_ptr, _copy_filter_coeffs, _load_native_lib, native_channel_stats_supported
from stats_passes import StatsPassContext, StatsPassResult
from stats_q_sums import combine_channel_sums
from stats_source_runner import SourcePrecomputeRunner
from stream_io import FrameChunk, FrameChunkReader


@dataclass
class _PairedStatsRunner:
    label: str
    ctx: StatsPassContext
    result: StatsPassResult
    source_stage: bytearray | None
    audit_tail: bytearray | None
    source_stage_start_frame: int = 0
    source_energy_stage_end_frame: int = 0
    source_device_stage_end_frame: int = 0
    source_stage_on_device: bool = False
    next_source_window: int = 0
    chunk_index: int = 0
    source_precompute: SourcePrecomputeRunner | None = None


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


def _new_result(ctx):
    return StatsPassResult(
        nbytes=ctx.cfg.nbytes,
        mib=ctx.cfg.mib,
        total_samples=ctx.cfg.total_samples,
        total_frames=ctx.cfg.total_frames,
        windows=ctx.cfg.windows,
        seconds=ctx.cfg.seconds,
        state_bytes=ctx.state_bytes,
    )


def _new_runner(label, ctx):
    cfg = ctx.cfg
    result = _new_result(ctx)
    source_stage_config = create_source_stage_config(cfg)
    runner = _PairedStatsRunner(
        label=label,
        ctx=ctx,
        result=result,
        source_stage=source_stage_config.source_stage,
        audit_tail=source_stage_config.audit_tail,
    )
    runner.source_precompute = SourcePrecomputeRunner(ctx, result)
    return runner


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
    stage_frames = len(runner.source_stage) // cfg.frame_bytes
    stage_end_frame = runner.source_stage_start_frame + stage_frames
    full_ready_windows = min(result.windows, stage_end_frame // cfg.frames_per_window)
    source_overlap_frames = cfg.frames_per_window * 29
    while full_ready_windows - runner.next_source_window >= cfg.source_precompute_windows:
        ready_windows = runner.next_source_window + cfg.source_precompute_windows
        _copy_native_source_start_states(runner, native, ready_windows)
        runner.next_source_window = runner.source_precompute.run_stage(
            runner.source_stage,
            runner.source_stage_start_frame,
            runner.next_source_window,
            ready_windows,
        )
        ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
        runner.source_stage_start_frame = runner.source_precompute.trim_exact_stage(
            runner.source_stage,
            runner.source_stage_start_frame,
            runner.next_source_window,
            source_overlap_frames,
            cfg.frame_bytes,
            cfg.frames_per_window,
        )


def _process_native_combined_runner(runner, native, chunk, chunks, *, combined_host_ptr, input_channels, channel_offset):
    ctx = runner.ctx
    cfg = ctx.cfg
    channels = ctx.args.channels
    compact_ptr = ctypes.POINTER(ctypes.c_double)()
    if runner.source_stage is not None:
        out_bytes = chunk.this_frames * cfg.frame_bytes
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
        ctypes.c_uint32(cfg.frames_per_window),
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
    ctx.emit_progress('stats_sums', 0.70 * (((chunk.frame_offset + chunk.this_frames) * cfg.frame_bytes) / float(cfg.nbytes)))
    runner.chunk_index += 1


def _finish_native_runner(runner, native, done_frames):
    ctx = runner.ctx
    cfg = ctx.cfg
    result = runner.result
    if cfg.streaming_io:
        runner.source_precompute.apply_streaming_size_update(done_frames * cfg.frame_bytes)
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


def _process_channel_stats_chunk(runner, chunk, chunks):
    ctx = runner.ctx
    args = ctx.args
    cfg = ctx.cfg
    result = runner.result
    host_in = ctx.host_io.host_in
    host_in_ptr = ctx.host_io.host_in_ptr

    ensure_default_channel_stats_path(cfg, 'paired single-runtime stats')

    frames_arg = ctypes.c_uint32(chunk.this_frames)
    frame_offset_arg = ctypes.c_uint32(chunk.frame_offset)
    this_samples = chunk.this_frames * args.channels
    if cfg.source_precompute_device_energy:
        source_energy_capacity_frames = cfg.source_precompute_stage_bytes // cfg.frame_bytes
        source_stage_frames = (chunk.frame_offset + chunk.this_frames) - runner.source_stage_start_frame
        if source_stage_frames > source_energy_capacity_frames:
            raise RuntimeError(f'paired source energy staging exceeded for {runner.label}: need_frames={source_stage_frames} capacity_frames={source_energy_capacity_frames}')
        source_energy_base_arg = ctypes.c_uint32(runner.source_stage_start_frame)
        source_energy_frames_arg = ctypes.c_uint32(source_energy_capacity_frames)
        channel_args = kernel_args.build_channel_stats_source_energy_args(
            ctx.bindings.in_arg,
            ctx.bindings.start_states_arg,
            ctx.bindings.peaks_arg,
            ctx.bindings.q_states_arg,
            ctx.bindings.source_start_states_arg,
            ctx.bindings.source_energy_arg,
            source_energy_base_arg,
            source_energy_frames_arg,
            frames_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            frame_offset_arg,
            ctx.bindings.b_arg,
            ctx.bindings.a_arg,
        )
        channel_kernel_fn = ctx.kernels.channel_sums_source_energy_fn
        channel_grid_x = args.channels
        channel_block_x = 1
    else:
        channel_args = kernel_args.build_channel_stats_args(
            ctx.bindings.in_arg,
            ctx.bindings.start_states_arg,
            ctx.bindings.peaks_arg,
            ctx.bindings.q_states_arg,
            ctx.bindings.source_start_states_arg,
            frames_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            frame_offset_arg,
            ctx.bindings.b_arg,
            ctx.bindings.a_arg,
        )
        use_channel_warp = bool(getattr(cfg, 'exact_channel_stats_warp', False))
        if use_channel_warp:
            channel_kernel_fn = ctx.kernels.channel_sums_warp_fn
        elif getattr(cfg, 'exact_channel_stats_unroll4', False):
            channel_kernel_fn = ctx.kernels.channel_sums_unroll4_fn
        else:
            channel_kernel_fn = ctx.kernels.channel_sums_fn
        channel_grid_x = 1 if use_channel_warp else args.channels
        channel_block_x = 32 if use_channel_warp else 1
    peak_args = kernel_args.build_peak_args(
        ctx.bindings.in_arg,
        ctx.bindings.peaks_arg,
        frames_arg,
        ctx.bindings.channels_arg,
        ctx.bindings.frame_window_arg,
        frame_offset_arg,
    )
    peak_grid = min(65535, max(1, (this_samples + 255) // 256))
    stage_t0 = time.perf_counter()
    t0 = time.perf_counter()
    chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_in, ctypes.c_void_p(host_in_ptr), chunk.this_bytes), f'cuMemcpyHtoD({runner.label} stats input)')
    copy_dt = time.perf_counter() - t0
    if cfg.exact_stats_fast_launch:
        kernel_t0 = time.perf_counter()
        launch_kernel(ctx.cuda, f'{runner.label}-window-peaks-fast', ctx.kernels.peak_fn, peak_args, grid_x=peak_grid, block_x=256)
        launch_kernel(ctx.cuda, f'{runner.label}-channel-stats-fast', channel_kernel_fn, channel_args, grid_x=channel_grid_x, block_x=channel_block_x)
        kernel_dt = time.perf_counter() - kernel_t0
    else:
        peak_dt = launch_timed_kernel(ctx.cuda, f'{runner.label}-window-peaks', ctx.kernels.peak_fn, peak_args, grid_x=peak_grid, block_x=256)
        channel_dt = launch_timed_kernel(ctx.cuda, f'{runner.label}-channel-stats', channel_kernel_fn, channel_args, grid_x=channel_grid_x, block_x=channel_block_x)
        kernel_dt = peak_dt + channel_dt

    result.stats_sums_h2d_time += copy_dt
    result.total_h2d_time += copy_dt
    result.stats_sums_kernel_time += kernel_dt
    result.stats_sums_wall_time += time.perf_counter() - stage_t0

    if runner.audit_tail is not None:
        runner.audit_tail.extend(memoryview(host_in)[:chunk.this_bytes])
        excess = len(runner.audit_tail) - cfg.audit_input_tail_bytes
        if excess > 0:
            del runner.audit_tail[:excess]

    if cfg.source_precompute_device_energy:
        runner.source_energy_stage_end_frame = chunk.frame_offset + chunk.this_frames
        full_ready_windows = min(result.windows, runner.source_energy_stage_end_frame // cfg.frames_per_window)
        source_overlap_frames = cfg.frames_per_window * 29
        while full_ready_windows - runner.next_source_window >= cfg.source_precompute_windows:
            ready_windows = runner.next_source_window + cfg.source_precompute_windows
            runner.next_source_window = runner.source_precompute.run_stage(
                None,
                runner.source_stage_start_frame,
                runner.next_source_window,
                ready_windows,
                device_energy_end_frame=runner.source_energy_stage_end_frame,
            )
            ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
            runner.source_stage_start_frame = runner.source_precompute.trim_energy_stage(
                runner.source_stage_start_frame,
                runner.source_energy_stage_end_frame,
                runner.next_source_window,
                source_overlap_frames,
            )

    if runner.source_stage is not None:
        runner.source_stage.extend(memoryview(host_in)[:chunk.this_bytes])
        stage_frames = len(runner.source_stage) // cfg.frame_bytes
        stage_end_frame = runner.source_stage_start_frame + stage_frames
        full_ready_windows = min(result.windows, stage_end_frame // cfg.frames_per_window)
        source_overlap_frames = cfg.frames_per_window * 29
        while full_ready_windows - runner.next_source_window >= cfg.source_precompute_windows:
            ready_windows = runner.next_source_window + cfg.source_precompute_windows
            runner.next_source_window = runner.source_precompute.run_stage(
                runner.source_stage,
                runner.source_stage_start_frame,
                runner.next_source_window,
                ready_windows,
            )
            ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
            runner.source_stage_start_frame = runner.source_precompute.trim_exact_stage(
                runner.source_stage,
                runner.source_stage_start_frame,
                runner.next_source_window,
                source_overlap_frames,
                cfg.frame_bytes,
                cfg.frames_per_window,
            )

    ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
    runner.chunk_index += 1


def _process_combined_channel_stats_chunk(runner, chunk, chunks, *, combined_input_arg, input_channels, channel_offset, copy_dt=0.0):
    ctx = runner.ctx
    args = ctx.args
    cfg = ctx.cfg
    result = runner.result

    if runner.audit_tail is not None or cfg.source_precompute_device_energy:
        raise RuntimeError('combined paired stats currently supports exact source staging without audits or device-energy staging')
    ensure_default_channel_stats_path(cfg, 'combined paired stats')

    frames_arg = ctypes.c_uint32(chunk.this_frames)
    frame_offset_arg = ctypes.c_uint32(chunk.frame_offset)
    input_channels_arg = ctypes.c_uint32(input_channels)
    channel_offset_arg = ctypes.c_uint32(channel_offset)
    this_samples = chunk.this_frames * args.channels
    channel_args = kernel_args.build_channel_stats_offset_args(
        combined_input_arg,
        ctx.bindings.start_states_arg,
        ctx.bindings.peaks_arg,
        ctx.bindings.q_states_arg,
        ctx.bindings.source_start_states_arg,
        frames_arg,
        ctx.bindings.channels_arg,
        input_channels_arg,
        channel_offset_arg,
        ctx.bindings.frame_window_arg,
        frame_offset_arg,
        ctx.bindings.b_arg,
        ctx.bindings.a_arg,
    )
    peak_args = kernel_args.build_peak_offset_args(
        combined_input_arg,
        ctx.bindings.peaks_arg,
        frames_arg,
        ctx.bindings.channels_arg,
        input_channels_arg,
        channel_offset_arg,
        ctx.bindings.frame_window_arg,
        frame_offset_arg,
    )
    compact_args = None
    compact_grid = 1
    if runner.source_stage is not None:
        runner.source_stage_on_device = True
        source_capacity_frames = cfg.source_precompute_stage_bytes // cfg.frame_bytes
        source_stage_frames = (chunk.frame_offset + chunk.this_frames) - runner.source_stage_start_frame
        if source_stage_frames > source_capacity_frames:
            raise RuntimeError(f'paired combined source staging exceeded for {runner.label}: need_frames={source_stage_frames} capacity_frames={source_capacity_frames}')
        compact_args = kernel_args.build_compact_offset_args(
            combined_input_arg,
            ctx.bindings.in_arg,
            frames_arg,
            ctx.bindings.channels_arg,
            input_channels_arg,
            channel_offset_arg,
            ctypes.c_uint32(runner.source_stage_start_frame),
            ctypes.c_uint32(source_capacity_frames),
            frame_offset_arg,
        )
        compact_grid = min(65535, max(1, (this_samples + 255) // 256))
    peak_grid = min(65535, max(1, (this_samples + 255) // 256))
    stage_t0 = time.perf_counter()
    if cfg.exact_stats_fast_launch:
        kernel_t0 = time.perf_counter()
        launch_kernel(ctx.cuda, f'{runner.label}-window-peaks-offset-fast', ctx.kernels.peak_offset_fn, peak_args, grid_x=peak_grid, block_x=256)
        launch_kernel(ctx.cuda, f'{runner.label}-channel-stats-offset-fast', ctx.kernels.channel_sums_offset_fn, channel_args, grid_x=args.channels)
        if compact_args is not None:
            launch_kernel(ctx.cuda, f'{runner.label}-compact-source-offset-fast', ctx.kernels.compact_offset_fn, compact_args, grid_x=compact_grid, block_x=256)
        kernel_dt = time.perf_counter() - kernel_t0
    else:
        peak_dt = launch_timed_kernel(ctx.cuda, f'{runner.label}-window-peaks-offset', ctx.kernels.peak_offset_fn, peak_args, grid_x=peak_grid, block_x=256)
        channel_dt = launch_timed_kernel(ctx.cuda, f'{runner.label}-channel-stats-offset', ctx.kernels.channel_sums_offset_fn, channel_args, grid_x=args.channels)
        compact_dt = 0.0
        if compact_args is not None:
            compact_dt = launch_timed_kernel(ctx.cuda, f'{runner.label}-compact-source-offset', ctx.kernels.compact_offset_fn, compact_args, grid_x=compact_grid, block_x=256)
        kernel_dt = peak_dt + channel_dt + compact_dt

    result.stats_sums_h2d_time += copy_dt
    result.total_h2d_time += copy_dt
    result.stats_sums_kernel_time += kernel_dt
    result.stats_sums_wall_time += copy_dt + (time.perf_counter() - stage_t0)
    if runner.source_stage is not None:
        runner.source_device_stage_end_frame = chunk.frame_offset + chunk.this_frames
        full_ready_windows = min(result.windows, runner.source_device_stage_end_frame // cfg.frames_per_window)
        source_overlap_frames = cfg.frames_per_window * 29
        while full_ready_windows - runner.next_source_window >= cfg.source_precompute_windows:
            ready_windows = runner.next_source_window + cfg.source_precompute_windows
            runner.next_source_window = runner.source_precompute.run_stage(
                None,
                runner.source_stage_start_frame,
                runner.next_source_window,
                ready_windows,
                device_input_end_frame=runner.source_device_stage_end_frame,
            )
            ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
            runner.source_stage_start_frame = runner.source_precompute.trim_input_device_stage(
                runner.source_stage_start_frame,
                runner.source_device_stage_end_frame,
                runner.next_source_window,
                source_overlap_frames,
            )
    ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
    runner.chunk_index += 1


def _advance_combined_source_stage(runner, chunk, chunks):
    if not runner.source_stage_on_device:
        return
    ctx = runner.ctx
    cfg = ctx.cfg
    result = runner.result
    runner.source_device_stage_end_frame = chunk.frame_offset + chunk.this_frames
    full_ready_windows = min(result.windows, runner.source_device_stage_end_frame // cfg.frames_per_window)
    source_overlap_frames = cfg.frames_per_window * 29
    while full_ready_windows - runner.next_source_window >= cfg.source_precompute_windows:
        ready_windows = runner.next_source_window + cfg.source_precompute_windows
        runner.next_source_window = runner.source_precompute.run_stage(
            None,
            runner.source_stage_start_frame,
            runner.next_source_window,
            ready_windows,
            device_input_end_frame=runner.source_device_stage_end_frame,
        )
        ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
        runner.source_stage_start_frame = runner.source_precompute.trim_input_device_stage(
            runner.source_stage_start_frame,
            runner.source_device_stage_end_frame,
            runner.next_source_window,
            source_overlap_frames,
        )


def _combined_compact_args(runner, chunk, *, combined_input_arg, input_channels, channel_offset):
    ctx = runner.ctx
    cfg = ctx.cfg
    if runner.source_stage is None:
        return None, 1
    runner.source_stage_on_device = True
    source_capacity_frames = cfg.source_precompute_stage_bytes // cfg.frame_bytes
    source_stage_frames = (chunk.frame_offset + chunk.this_frames) - runner.source_stage_start_frame
    if source_stage_frames > source_capacity_frames:
        raise RuntimeError(f'paired fused source staging exceeded for {runner.label}: need_frames={source_stage_frames} capacity_frames={source_capacity_frames}')
    compact_args = kernel_args.build_compact_offset_args(
        combined_input_arg,
        ctx.bindings.in_arg,
        ctypes.c_uint32(chunk.this_frames),
        ctx.bindings.channels_arg,
        ctypes.c_uint32(input_channels),
        ctypes.c_uint32(channel_offset),
        ctypes.c_uint32(runner.source_stage_start_frame),
        ctypes.c_uint32(source_capacity_frames),
        ctypes.c_uint32(chunk.frame_offset),
    )
    compact_grid = min(65535, max(1, (chunk.this_frames * ctx.args.channels + 255) // 256))
    return compact_args, compact_grid


def _process_fused_combined_channel_stats_chunk(primary, partner, chunk, chunks, *, combined_input, combined_input_arg, combined_host_ptr, input_channels):
    for runner in (primary, partner):
        if runner.audit_tail is not None or runner.ctx.cfg.source_precompute_device_energy:
            raise RuntimeError('fused paired stats currently supports exact source staging without audits or device-energy staging')
        ensure_default_channel_stats_path(runner.ctx.cfg, 'fused paired stats')
    primary_ctx = primary.ctx
    partner_ctx = partner.ctx
    frames_arg = ctypes.c_uint32(chunk.this_frames)
    frame_offset_arg = ctypes.c_uint32(chunk.frame_offset)
    input_channels_arg = ctypes.c_uint32(input_channels)
    partner_offset_arg = ctypes.c_uint32(primary_ctx.args.channels)
    fused_args = kernel_args.build_paired_combined_channel_stats_args(
        combined_input_arg,
        primary_ctx.bindings.start_states_arg,
        primary_ctx.bindings.peaks_arg,
        primary_ctx.bindings.q_states_arg,
        primary_ctx.bindings.source_start_states_arg,
        partner_ctx.bindings.start_states_arg,
        partner_ctx.bindings.peaks_arg,
        partner_ctx.bindings.q_states_arg,
        partner_ctx.bindings.source_start_states_arg,
        frames_arg,
        primary_ctx.bindings.channels_arg,
        partner_ctx.bindings.channels_arg,
        input_channels_arg,
        partner_offset_arg,
        primary_ctx.bindings.frame_window_arg,
        frame_offset_arg,
        primary_ctx.bindings.b_arg,
        primary_ctx.bindings.a_arg,
    )
    primary_compact_args, primary_compact_grid = _combined_compact_args(
        primary,
        chunk,
        combined_input_arg=combined_input_arg,
        input_channels=input_channels,
        channel_offset=0,
    )
    partner_compact_args, partner_compact_grid = _combined_compact_args(
        partner,
        chunk,
        combined_input_arg=combined_input_arg,
        input_channels=input_channels,
        channel_offset=primary_ctx.args.channels,
    )

    stage_t0 = time.perf_counter()
    copy_t0 = time.perf_counter()
    chk(primary_ctx.cuda.cuMemcpyHtoD_v2(combined_input, ctypes.c_void_p(combined_host_ptr), chunk.this_bytes), 'cuMemcpyHtoD(paired fused stats input)')
    copy_dt = time.perf_counter() - copy_t0
    if primary_ctx.cfg.exact_stats_fast_launch:
        kernel_t0 = time.perf_counter()
        launch_kernel(primary_ctx.cuda, 'paired-fused-channel-stats-fast', primary_ctx.kernels.paired_channel_sums_fn, fused_args, grid_x=1, block_x=32)
        if primary_compact_args is not None:
            launch_kernel(primary_ctx.cuda, 'primary-compact-source-fused-fast', primary_ctx.kernels.compact_offset_fn, primary_compact_args, grid_x=primary_compact_grid, block_x=256)
        if partner_compact_args is not None:
            launch_kernel(partner_ctx.cuda, 'partner-compact-source-fused-fast', partner_ctx.kernels.compact_offset_fn, partner_compact_args, grid_x=partner_compact_grid, block_x=256)
        kernel_dt = time.perf_counter() - kernel_t0
    else:
        kernel_dt = launch_timed_kernel(primary_ctx.cuda, 'paired-fused-channel-stats', primary_ctx.kernels.paired_channel_sums_fn, fused_args, grid_x=1, block_x=32)
        if primary_compact_args is not None:
            kernel_dt += launch_timed_kernel(primary_ctx.cuda, 'primary-compact-source-fused', primary_ctx.kernels.compact_offset_fn, primary_compact_args, grid_x=primary_compact_grid, block_x=256)
        if partner_compact_args is not None:
            kernel_dt += launch_timed_kernel(partner_ctx.cuda, 'partner-compact-source-fused', partner_ctx.kernels.compact_offset_fn, partner_compact_args, grid_x=partner_compact_grid, block_x=256)
    wall_dt = time.perf_counter() - stage_t0

    primary.result.stats_sums_h2d_time += copy_dt
    primary.result.total_h2d_time += copy_dt
    for runner in (primary, partner):
        runner.result.stats_sums_kernel_time += kernel_dt
        runner.result.stats_sums_wall_time += wall_dt
    primary_progress = SimpleNamespace(done_bytes=(chunk.frame_offset + chunk.this_frames) * primary_ctx.cfg.frame_bytes)
    partner_progress = SimpleNamespace(done_bytes=(chunk.frame_offset + chunk.this_frames) * partner_ctx.cfg.frame_bytes)
    _advance_combined_source_stage(primary, chunk, primary_progress)
    _advance_combined_source_stage(partner, chunk, partner_progress)
    primary.ctx.emit_progress('stats_sums', 0.70 * (primary_progress.done_bytes / float(primary.ctx.cfg.nbytes)))
    partner.ctx.emit_progress('stats_sums', 0.70 * (partner_progress.done_bytes / float(partner.ctx.cfg.nbytes)))
    primary.chunk_index += 1
    partner.chunk_index += 1


def _finish_runner(runner, chunks):
    ctx = runner.ctx
    cfg = ctx.cfg
    result = runner.result
    if cfg.streaming_io:
        runner.source_precompute.apply_streaming_size_update(chunks.done_bytes)
    if runner.source_stage_on_device:
        if result.windows > runner.next_source_window:
            runner.next_source_window = runner.source_precompute.run_stage(
                None,
                runner.source_stage_start_frame,
                runner.next_source_window,
                result.windows,
                device_input_end_frame=runner.source_device_stage_end_frame,
            )
        if runner.next_source_window != result.windows:
            raise RuntimeError(f'paired combined source exact precompute incomplete for {runner.label}: windows={runner.next_source_window} expected={result.windows}')
        runner.source_precompute.finish_source_sum_audit()
    elif cfg.source_precompute_device_energy:
        if result.windows > runner.next_source_window:
            runner.next_source_window = runner.source_precompute.run_stage(
                None,
                runner.source_stage_start_frame,
                runner.next_source_window,
                result.windows,
                device_energy_end_frame=runner.source_energy_stage_end_frame,
            )
        if runner.next_source_window != result.windows:
            raise RuntimeError(f'paired fused source device precompute incomplete for {runner.label}: windows={runner.next_source_window} expected={result.windows}')
        runner.source_precompute.finish_source_sum_audit()
    elif runner.source_stage is not None:
        if result.windows > runner.next_source_window:
            runner.next_source_window = runner.source_precompute.run_stage(
                runner.source_stage,
                runner.source_stage_start_frame,
                runner.next_source_window,
                result.windows,
            )
        if runner.next_source_window != result.windows:
            raise RuntimeError(f'paired fused source exact precompute incomplete for {runner.label}: windows={runner.next_source_window} expected={result.windows}')
        runner.source_precompute.finish_source_sum_audit()
    combine_channel_sums(ctx, result, source_arg=ctx.bindings.start_states_arg, label=f'{runner.label}-combine-channel-sums')
    runner.source_precompute.run_pass()
    if runner.audit_tail is not None:
        runner.source_precompute.audit_ffmpeg_input_metrics(runner.audit_tail)
    ctx.emit_progress('stats_sums', 0.70)


def _reader_for(runner):
    ctx = runner.ctx
    return FrameChunkReader(
        ctx.args,
        ctx.cfg.streaming_io,
        ctx.cfg.decode_command,
        f'paired {runner.label} streaming decode stats channel',
        ctx.host_io.host_in,
        nbytes=ctx.cfg.nbytes,
        chunk_bytes=ctx.cfg.stats_chunk_bytes,
        frame_bytes=ctx.cfg.frame_bytes,
        partial_frame_error=f'paired {runner.label} streaming channel stats ended with a partial frame',
        staging_label=f'paired {runner.label} streaming channel stats staging',
        short_read_error=f'short input read during paired {runner.label} channel stats',
    )


def _poll_prefetch_chunk(reader):
    if not reader.prefetch_enabled or reader.prefetch_queue is None:
        raise RuntimeError('paired single-runtime stats requires decode prefetch queues')
    try:
        item = reader.prefetch_queue.get(timeout=0.05)
    except queue.Empty:
        return None
    kind, *payload = item
    if kind == 'done':
        reader.done_bytes, reader.frame_offset = payload
        return 'done'
    if kind == 'error':
        raise payload[0]
    data, done_bytes, frame_offset = payload
    this_bytes = len(data)
    if this_bytes % reader.frame_bytes:
        raise RuntimeError(reader.alignment_error)
    if this_bytes > len(reader.host_buffer):
        raise RuntimeError(f'{reader.staging_label} exceeded: need={this_bytes} capacity={len(reader.host_buffer)}')
    memoryview(reader.host_buffer)[:this_bytes] = data
    this_frames = this_bytes // reader.frame_bytes
    reader.done_bytes = done_bytes + this_bytes
    reader.frame_offset = frame_offset + this_frames
    return FrameChunk(
        this_bytes=this_bytes,
        this_frames=this_frames,
        done_bytes=done_bytes,
        frame_offset=frame_offset,
    )


def build_stats_context(cuda, args, cfg, buffers, kernels, bindings, state_bytes, host_io, a_coeffs, emit_progress):
    return StatsPassContext(
        cuda=cuda,
        args=args,
        cfg=cfg,
        buffers=buffers,
        kernels=kernels,
        bindings=bindings,
        state_bytes=state_bytes,
        host_io=host_io,
        a_coeffs=a_coeffs,
        emit_progress=emit_progress,
    )


def run_paired_stats_pass(primary_ctx, partner_ctx):
    primary = _new_runner('primary', primary_ctx)
    partner = _new_runner('partner', partner_ctx)
    with _reader_for(primary) as primary_chunks, _reader_for(partner) as partner_chunks:
        primary_active = True
        partner_active = True
        while primary_active or partner_active:
            progressed = False
            if primary_active:
                chunk = _poll_prefetch_chunk(primary_chunks)
                if chunk == 'done':
                    primary_active = False
                    progressed = True
                elif chunk is not None:
                    _process_channel_stats_chunk(primary, chunk, primary_chunks)
                    progressed = True
            if partner_active:
                chunk = _poll_prefetch_chunk(partner_chunks)
                if chunk == 'done':
                    partner_active = False
                    progressed = True
                elif chunk is not None:
                    _process_channel_stats_chunk(partner, chunk, partner_chunks)
                    progressed = True
            if not progressed:
                time.sleep(0.01)
        _finish_runner(primary, primary_chunks)
        _finish_runner(partner, partner_chunks)
    return SimpleNamespace(primary=primary.result, partner=partner.result)


def run_paired_stats_combined_pass(primary_ctx, partner_ctx, combined_decode_command, combined_channels):
    primary = _new_runner('primary', primary_ctx)
    partner = _new_runner('partner', partner_ctx)
    if primary_ctx.args.input_format != 'f64le' or partner_ctx.args.input_format != 'f64le':
        raise RuntimeError('combined paired stats requires f64le input')
    if primary_ctx.args.rate != partner_ctx.args.rate:
        raise RuntimeError('combined paired stats requires matching sample rates')
    if combined_channels < primary_ctx.args.channels + partner_ctx.args.channels:
        raise RuntimeError('combined paired stats channel count is too small')

    frames_per_chunk = min(
        max(1, primary_ctx.cfg.stats_chunk_bytes // primary_ctx.cfg.frame_bytes),
        max(1, partner_ctx.cfg.stats_chunk_bytes // partner_ctx.cfg.frame_bytes),
    )
    combined_frame_bytes = combined_channels * 8
    combined_chunk_bytes = frames_per_chunk * combined_frame_bytes
    combined_capacity_bytes = max(combined_chunk_bytes, combined_frame_bytes)
    combined_host = bytearray(combined_capacity_bytes)
    combined_host_ptr = ctypes.addressof(ctypes.c_char.from_buffer(combined_host))
    combined_nbytes = max(primary_ctx.cfg.total_frames, partner_ctx.cfg.total_frames) * combined_frame_bytes
    use_native = _can_use_paired_native_combined(primary, partner)
    combined_input = ctypes.c_void_p()
    if not use_native:
        chk(primary_ctx.cuda.cuMemAlloc_v2(ctypes.byref(combined_input), combined_capacity_bytes), 'cuMemAlloc(paired_combined_input)')
    combined_input_arg = ctypes.c_uint64(combined_input.value if combined_input.value else 0)
    reader_args = SimpleNamespace(input_f32='-', channels=combined_channels)
    try:
        primary_native = _native_state_for(primary) if use_native else None
        partner_native = _native_state_for(partner) if use_native else None
        with FrameChunkReader(
            reader_args,
            True,
            combined_decode_command,
            'paired combined streaming decode stats channel',
            combined_host,
            nbytes=combined_nbytes,
            chunk_bytes=combined_chunk_bytes,
            frame_bytes=combined_frame_bytes,
            partial_frame_error='paired combined streaming channel stats ended with a partial frame',
            staging_label='paired combined streaming channel stats staging',
            short_read_error='short input read during paired combined channel stats',
        ) as chunks:
            use_fused_kernel = bool(getattr(primary_ctx.cfg, 'exact_paired_stats_fused_kernel', False))
            for chunk in chunks:
                if use_native:
                    _process_native_combined_runner(
                        primary,
                        primary_native,
                        chunk,
                        chunks,
                        combined_host_ptr=combined_host_ptr,
                        input_channels=combined_channels,
                        channel_offset=0,
                    )
                    _process_native_combined_runner(
                        partner,
                        partner_native,
                        chunk,
                        chunks,
                        combined_host_ptr=combined_host_ptr,
                        input_channels=combined_channels,
                        channel_offset=primary_ctx.args.channels,
                    )
                    continue
                if use_fused_kernel:
                    _process_fused_combined_channel_stats_chunk(
                        primary,
                        partner,
                        chunk,
                        chunks,
                        combined_input=combined_input,
                        combined_input_arg=combined_input_arg,
                        combined_host_ptr=combined_host_ptr,
                        input_channels=combined_channels,
                    )
                    continue
                copy_t0 = time.perf_counter()
                chk(primary_ctx.cuda.cuMemcpyHtoD_v2(combined_input, ctypes.c_void_p(combined_host_ptr), chunk.this_bytes), 'cuMemcpyHtoD(paired combined stats input)')
                copy_dt = time.perf_counter() - copy_t0
                primary_chunk = FrameChunk(
                    this_bytes=chunk.this_frames * primary_ctx.cfg.frame_bytes,
                    this_frames=chunk.this_frames,
                    done_bytes=chunk.frame_offset * primary_ctx.cfg.frame_bytes,
                    frame_offset=chunk.frame_offset,
                )
                partner_chunk = FrameChunk(
                    this_bytes=chunk.this_frames * partner_ctx.cfg.frame_bytes,
                    this_frames=chunk.this_frames,
                    done_bytes=chunk.frame_offset * partner_ctx.cfg.frame_bytes,
                    frame_offset=chunk.frame_offset,
                )
                primary_progress = SimpleNamespace(done_bytes=primary_chunk.done_bytes + primary_chunk.this_bytes)
                partner_progress = SimpleNamespace(done_bytes=partner_chunk.done_bytes + partner_chunk.this_bytes)
                _process_combined_channel_stats_chunk(primary, primary_chunk, primary_progress, combined_input_arg=combined_input_arg, input_channels=combined_channels, channel_offset=0, copy_dt=copy_dt)
                _process_combined_channel_stats_chunk(partner, partner_chunk, partner_progress, combined_input_arg=combined_input_arg, input_channels=combined_channels, channel_offset=primary_ctx.args.channels, copy_dt=0.0)
            primary_done = SimpleNamespace(done_bytes=chunks.frame_offset * primary_ctx.cfg.frame_bytes)
            partner_done = SimpleNamespace(done_bytes=chunks.frame_offset * partner_ctx.cfg.frame_bytes)
            if use_native:
                _finish_native_runner(primary, primary_native, chunks.frame_offset)
                _finish_native_runner(partner, partner_native, chunks.frame_offset)
            else:
                _finish_runner(primary, primary_done)
                _finish_runner(partner, partner_done)
    finally:
        if combined_input.value:
            primary_ctx.cuda.cuMemFree_v2(combined_input)
    return SimpleNamespace(primary=primary.result, partner=partner.result)
