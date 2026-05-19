from __future__ import annotations

from dataclasses import dataclass
import ctypes
import queue
from types import SimpleNamespace
import time

from cuda_driver import chk
from cuda_launch import launch_kernel, launch_timed_kernel
import kernel_args
from stats_passes import StatsPassContext, StatsPassResult
from stats_subpasses import (
    _apply_streaming_size_update,
    _audit_ffmpeg_input_metrics,
    _finish_source_sum_audit,
    _run_source_exact_precompute_stage,
    _trim_source_exact_stage,
    combine_channel_sums,
    run_source_exact_precompute_pass,
)
from stream_io import FrameChunk, FrameChunkReader


@dataclass
class _PairedStatsRunner:
    label: str
    ctx: StatsPassContext
    result: StatsPassResult
    source_stage: bytearray | None
    audit_tail: bytearray | None
    source_stage_start_frame: int = 0
    next_source_window: int = 0
    chunk_index: int = 0


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
    return _PairedStatsRunner(
        label=label,
        ctx=ctx,
        result=_new_result(ctx),
        source_stage=bytearray() if (cfg.source_precompute_in_stats or cfg.source_channel_hist4_exact or cfg.source_channel_hist4_boundary or cfg.source_channel_short_exact or cfg.source_channel_short_boundary) else None,
        audit_tail=bytearray() if (cfg.audit_ffmpeg_input_metrics or cfg.emit_first_pass_json) else None,
    )


def _process_channel_stats_chunk(runner, chunk, chunks):
    ctx = runner.ctx
    args = ctx.args
    cfg = ctx.cfg
    result = runner.result
    host_in = ctx.host_io.host_in
    host_in_ptr = ctx.host_io.host_in_ptr

    if cfg.exact_stats_async_pipeline or cfg.exact_stats_parallel_peaks or cfg.exact_channel_stats_combined_peaks:
        raise RuntimeError('paired single-runtime stats supports the default exact channel stats path only')

    frames_arg = ctypes.c_uint32(chunk.this_frames)
    frame_offset_arg = ctypes.c_uint32(chunk.frame_offset)
    this_samples = chunk.this_frames * args.channels
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
        launch_kernel(ctx.cuda, f'{runner.label}-channel-stats-fast', ctx.kernels.channel_sums_fn, channel_args, grid_x=args.channels)
        kernel_dt = time.perf_counter() - kernel_t0
    else:
        peak_dt = launch_timed_kernel(ctx.cuda, f'{runner.label}-window-peaks', ctx.kernels.peak_fn, peak_args, grid_x=peak_grid, block_x=256)
        channel_dt = launch_timed_kernel(ctx.cuda, f'{runner.label}-channel-stats', ctx.kernels.channel_sums_fn, channel_args, grid_x=args.channels)
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

    if runner.source_stage is not None:
        runner.source_stage.extend(memoryview(host_in)[:chunk.this_bytes])
        stage_frames = len(runner.source_stage) // cfg.frame_bytes
        stage_end_frame = runner.source_stage_start_frame + stage_frames
        full_ready_windows = min(result.windows, stage_end_frame // cfg.frames_per_window)
        source_overlap_frames = cfg.frames_per_window * 29
        while full_ready_windows - runner.next_source_window >= cfg.source_precompute_windows:
            ready_windows = runner.next_source_window + cfg.source_precompute_windows
            runner.next_source_window = _run_source_exact_precompute_stage(
                ctx,
                result,
                runner.source_stage,
                runner.source_stage_start_frame,
                runner.next_source_window,
                ready_windows,
            )
            ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
            runner.source_stage_start_frame = _trim_source_exact_stage(
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

    if runner.source_stage is not None or runner.audit_tail is not None:
        raise RuntimeError('combined paired stats currently supports channel-sum source precompute without raw-input audit stages')
    if cfg.exact_stats_async_pipeline or cfg.exact_stats_parallel_peaks or cfg.exact_channel_stats_combined_peaks:
        raise RuntimeError('combined paired stats supports the default exact channel stats path only')

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
    peak_grid = min(65535, max(1, (this_samples + 255) // 256))
    stage_t0 = time.perf_counter()
    if cfg.exact_stats_fast_launch:
        kernel_t0 = time.perf_counter()
        launch_kernel(ctx.cuda, f'{runner.label}-window-peaks-offset-fast', ctx.kernels.peak_offset_fn, peak_args, grid_x=peak_grid, block_x=256)
        launch_kernel(ctx.cuda, f'{runner.label}-channel-stats-offset-fast', ctx.kernels.channel_sums_offset_fn, channel_args, grid_x=args.channels)
        kernel_dt = time.perf_counter() - kernel_t0
    else:
        peak_dt = launch_timed_kernel(ctx.cuda, f'{runner.label}-window-peaks-offset', ctx.kernels.peak_offset_fn, peak_args, grid_x=peak_grid, block_x=256)
        channel_dt = launch_timed_kernel(ctx.cuda, f'{runner.label}-channel-stats-offset', ctx.kernels.channel_sums_offset_fn, channel_args, grid_x=args.channels)
        kernel_dt = peak_dt + channel_dt

    result.stats_sums_h2d_time += copy_dt
    result.total_h2d_time += copy_dt
    result.stats_sums_kernel_time += kernel_dt
    result.stats_sums_wall_time += copy_dt + (time.perf_counter() - stage_t0)
    ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
    runner.chunk_index += 1


def _finish_runner(runner, chunks):
    ctx = runner.ctx
    cfg = ctx.cfg
    result = runner.result
    if cfg.streaming_io:
        _apply_streaming_size_update(ctx, result, chunks.done_bytes)
    if runner.source_stage is not None:
        if result.windows > runner.next_source_window:
            runner.next_source_window = _run_source_exact_precompute_stage(
                ctx,
                result,
                runner.source_stage,
                runner.source_stage_start_frame,
                runner.next_source_window,
                result.windows,
            )
        if runner.next_source_window != result.windows:
            raise RuntimeError(f'paired fused source exact precompute incomplete for {runner.label}: windows={runner.next_source_window} expected={result.windows}')
        _finish_source_sum_audit(ctx)
    combine_channel_sums(ctx, result, source_arg=ctx.bindings.start_states_arg, label=f'{runner.label}-combine-channel-sums')
    run_source_exact_precompute_pass(ctx, result)
    if runner.audit_tail is not None:
        _audit_ffmpeg_input_metrics(ctx, result, runner.audit_tail)
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
    combined_input = ctypes.c_void_p()
    chk(primary_ctx.cuda.cuMemAlloc_v2(ctypes.byref(combined_input), combined_capacity_bytes), 'cuMemAlloc(paired_combined_input)')
    combined_input_arg = ctypes.c_uint64(combined_input.value)
    reader_args = SimpleNamespace(input_f32='-', channels=combined_channels)
    try:
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
            for chunk in chunks:
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
            _finish_runner(primary, primary_done)
            _finish_runner(partner, partner_done)
    finally:
        if combined_input.value:
            primary_ctx.cuda.cuMemFree_v2(combined_input)
    return SimpleNamespace(primary=primary.result, partner=partner.result)
