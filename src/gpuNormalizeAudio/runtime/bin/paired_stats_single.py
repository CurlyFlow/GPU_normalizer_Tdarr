import ctypes
import queue
from types import SimpleNamespace
import time

from cuda_driver import chk
from cuda_launch import launch_kernel, launch_timed_kernel
import kernel_args
from paired_stats_state import _finish_runner, _new_runner
from stats_channel_pipeline import ensure_default_channel_stats_path
from stream_chunk_reader import FrameChunk, FrameChunkReader


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
    if cfg.source.source_precompute_device_energy:
        source_energy_capacity_frames = cfg.sizing.source_precompute_stage_bytes // cfg.sizing.frame_bytes
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
        use_channel_warp = bool(getattr(cfg.exact, 'exact_channel_stats_warp', False))
        if use_channel_warp:
            channel_kernel_fn = ctx.kernels.channel_sums_warp_fn
        elif getattr(cfg.exact, 'exact_channel_stats_unroll4', False):
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
    if cfg.exact.exact_stats_fast_launch:
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
        excess = len(runner.audit_tail) - cfg.sizing.audit_input_tail_bytes
        if excess > 0:
            del runner.audit_tail[:excess]

    if cfg.source.source_precompute_device_energy:
        runner.source_energy_stage_end_frame = chunk.frame_offset + chunk.this_frames
        full_ready_windows = min(result.windows, runner.source_energy_stage_end_frame // cfg.input_shape.frames_per_window)
        source_overlap_frames = cfg.input_shape.frames_per_window * 29
        while full_ready_windows - runner.next_source_window >= cfg.sizing.source_precompute_windows:
            ready_windows = runner.next_source_window + cfg.sizing.source_precompute_windows
            runner.next_source_window = runner.source_precompute.run_stage(
                None,
                runner.source_stage_start_frame,
                runner.next_source_window,
                ready_windows,
                device_energy_end_frame=runner.source_energy_stage_end_frame,
            )
            ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.input_shape.nbytes)))
            runner.source_stage_start_frame = runner.source_precompute.trim_energy_stage(
                runner.source_stage_start_frame,
                runner.source_energy_stage_end_frame,
                runner.next_source_window,
                source_overlap_frames,
            )

    if runner.source_stage is not None:
        runner.source_stage.extend(memoryview(host_in)[:chunk.this_bytes])
        stage_frames = len(runner.source_stage) // cfg.sizing.frame_bytes
        stage_end_frame = runner.source_stage_start_frame + stage_frames
        full_ready_windows = min(result.windows, stage_end_frame // cfg.input_shape.frames_per_window)
        source_overlap_frames = cfg.input_shape.frames_per_window * 29
        while full_ready_windows - runner.next_source_window >= cfg.sizing.source_precompute_windows:
            ready_windows = runner.next_source_window + cfg.sizing.source_precompute_windows
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

    ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.input_shape.nbytes)))
    runner.chunk_index += 1


def _reader_for(runner):
    ctx = runner.ctx
    return FrameChunkReader(
        ctx.args,
        ctx.cfg.root.streaming_io,
        ctx.cfg.input_shape.decode_command,
        f'paired {runner.label} streaming decode stats channel',
        ctx.host_io.host_in,
        nbytes=ctx.cfg.input_shape.nbytes,
        chunk_bytes=ctx.cfg.sizing.stats_chunk_bytes,
        frame_bytes=ctx.cfg.sizing.frame_bytes,
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
