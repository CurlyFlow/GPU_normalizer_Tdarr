import ctypes
from types import SimpleNamespace
import time

from cuda_driver import chk
from cuda_launch import launch_kernel, launch_timed_kernel
import kernel_args
from paired_stats_native import _can_use_paired_native_combined, _finish_native_runner, _native_state_for, _process_native_combined_runner
from paired_stats_state import _finish_runner, _new_runner
from stats_channel_pipeline import ensure_default_channel_stats_path
from stream_chunk_reader import FrameChunk, FrameChunkReader


def _process_combined_channel_stats_chunk(runner, chunk, chunks, *, combined_input_arg, input_channels, channel_offset, copy_dt=0.0):
    ctx = runner.ctx
    args = ctx.args
    cfg = ctx.cfg
    result = runner.result

    if runner.audit_tail is not None or cfg.source.source_precompute_device_energy:
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
        source_capacity_frames = cfg.sizing.source_precompute_stage_bytes // cfg.sizing.frame_bytes
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
    if cfg.exact.exact_stats_fast_launch:
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
        full_ready_windows = min(result.windows, runner.source_device_stage_end_frame // cfg.input_shape.frames_per_window)
        source_overlap_frames = cfg.input_shape.frames_per_window * 29
        while full_ready_windows - runner.next_source_window >= cfg.sizing.source_precompute_windows:
            ready_windows = runner.next_source_window + cfg.sizing.source_precompute_windows
            runner.next_source_window = runner.source_precompute.run_stage(
                None,
                runner.source_stage_start_frame,
                runner.next_source_window,
                ready_windows,
                device_input_end_frame=runner.source_device_stage_end_frame,
            )
            ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.input_shape.nbytes)))
            runner.source_stage_start_frame = runner.source_precompute.trim_input_device_stage(
                runner.source_stage_start_frame,
                runner.source_device_stage_end_frame,
                runner.next_source_window,
                source_overlap_frames,
            )
    ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.input_shape.nbytes)))
    runner.chunk_index += 1


def _advance_combined_source_stage(runner, chunk, chunks):
    if not runner.source_stage_on_device:
        return
    ctx = runner.ctx
    cfg = ctx.cfg
    result = runner.result
    runner.source_device_stage_end_frame = chunk.frame_offset + chunk.this_frames
    full_ready_windows = min(result.windows, runner.source_device_stage_end_frame // cfg.input_shape.frames_per_window)
    source_overlap_frames = cfg.input_shape.frames_per_window * 29
    while full_ready_windows - runner.next_source_window >= cfg.sizing.source_precompute_windows:
        ready_windows = runner.next_source_window + cfg.sizing.source_precompute_windows
        runner.next_source_window = runner.source_precompute.run_stage(
            None,
            runner.source_stage_start_frame,
            runner.next_source_window,
            ready_windows,
            device_input_end_frame=runner.source_device_stage_end_frame,
        )
        ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.input_shape.nbytes)))
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
    source_capacity_frames = cfg.sizing.source_precompute_stage_bytes // cfg.sizing.frame_bytes
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
        if runner.audit_tail is not None or runner.ctx.cfg.source.source_precompute_device_energy:
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
    if primary_ctx.cfg.exact.exact_stats_fast_launch:
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
    primary_progress = SimpleNamespace(done_bytes=(chunk.frame_offset + chunk.this_frames) * primary_ctx.cfg.sizing.frame_bytes)
    partner_progress = SimpleNamespace(done_bytes=(chunk.frame_offset + chunk.this_frames) * partner_ctx.cfg.sizing.frame_bytes)
    _advance_combined_source_stage(primary, chunk, primary_progress)
    _advance_combined_source_stage(partner, chunk, partner_progress)
    primary.ctx.emit_progress('stats_sums', 0.70 * (primary_progress.done_bytes / float(primary.ctx.cfg.input_shape.nbytes)))
    partner.ctx.emit_progress('stats_sums', 0.70 * (partner_progress.done_bytes / float(partner.ctx.cfg.input_shape.nbytes)))
    primary.chunk_index += 1
    partner.chunk_index += 1


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
        max(1, primary_ctx.cfg.sizing.stats_chunk_bytes // primary_ctx.cfg.sizing.frame_bytes),
        max(1, partner_ctx.cfg.sizing.stats_chunk_bytes // partner_ctx.cfg.sizing.frame_bytes),
    )
    combined_frame_bytes = combined_channels * 8
    combined_chunk_bytes = frames_per_chunk * combined_frame_bytes
    combined_capacity_bytes = max(combined_chunk_bytes, combined_frame_bytes)
    combined_host = bytearray(combined_capacity_bytes)
    combined_host_ptr = ctypes.addressof(ctypes.c_char.from_buffer(combined_host))
    combined_nbytes = max(primary_ctx.cfg.input_shape.total_frames, partner_ctx.cfg.input_shape.total_frames) * combined_frame_bytes
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
            use_fused_kernel = bool(getattr(primary_ctx.cfg.exact, 'exact_paired_stats_fused_kernel', False))
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
                    this_bytes=chunk.this_frames * primary_ctx.cfg.sizing.frame_bytes,
                    this_frames=chunk.this_frames,
                    done_bytes=chunk.frame_offset * primary_ctx.cfg.sizing.frame_bytes,
                    frame_offset=chunk.frame_offset,
                )
                partner_chunk = FrameChunk(
                    this_bytes=chunk.this_frames * partner_ctx.cfg.sizing.frame_bytes,
                    this_frames=chunk.this_frames,
                    done_bytes=chunk.frame_offset * partner_ctx.cfg.sizing.frame_bytes,
                    frame_offset=chunk.frame_offset,
                )
                primary_progress = SimpleNamespace(done_bytes=primary_chunk.done_bytes + primary_chunk.this_bytes)
                partner_progress = SimpleNamespace(done_bytes=partner_chunk.done_bytes + partner_chunk.this_bytes)
                _process_combined_channel_stats_chunk(primary, primary_chunk, primary_progress, combined_input_arg=combined_input_arg, input_channels=combined_channels, channel_offset=0, copy_dt=copy_dt)
                _process_combined_channel_stats_chunk(partner, partner_chunk, partner_progress, combined_input_arg=combined_input_arg, input_channels=combined_channels, channel_offset=primary_ctx.args.channels, copy_dt=0.0)
            primary_done = SimpleNamespace(done_bytes=chunks.frame_offset * primary_ctx.cfg.sizing.frame_bytes)
            partner_done = SimpleNamespace(done_bytes=chunks.frame_offset * partner_ctx.cfg.sizing.frame_bytes)
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
