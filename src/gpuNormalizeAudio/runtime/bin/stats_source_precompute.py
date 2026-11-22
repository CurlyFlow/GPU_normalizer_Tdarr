import ctypes
import time

from cuda_launch import launch_timed_kernel
import kernel_args
from stats_source_audit import _finish_source_sum_audit
from stats_source_precompute_stage import _run_source_exact_precompute_stage
from stream_ingress_resample import frame_chunk_reader_for


def _run_source_exact_precompute_stream(ctx, result):
    cfg = ctx.cfg
    host_view = memoryview(ctx.host_io.host_in)
    stage = bytearray()
    stage_start_frame = 0
    next_window = 0
    overlap_frames = cfg.input_shape.frames_per_window * 29

    with frame_chunk_reader_for(
        ctx,
        cfg.input_shape.decode_command,
        'streaming source exact precompute',
        ctx.host_io.host_in,
        chunk_bytes=cfg.sizing.source_precompute_chunk_bytes,
        partial_frame_error='streaming source exact precompute ended with a partial frame',
        staging_label='streaming source exact precompute staging',
        short_read_error='short input read during source exact precompute',
        ) as chunks:
        for chunk in chunks:
            stage.extend(host_view[:chunk.this_bytes])
            stage_frames = len(stage) // cfg.sizing.frame_bytes
            stage_end_frame = stage_start_frame + stage_frames
            final_chunk = (chunk.done_bytes + chunk.this_bytes) >= result.nbytes
            ready_windows = min(result.windows, stage_end_frame // cfg.input_shape.frames_per_window)
            if final_chunk:
                ready_windows = result.windows

            if ready_windows > next_window:
                next_window = _run_source_exact_precompute_stage(ctx, result, stage, stage_start_frame, next_window, ready_windows)
                ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(result.nbytes)))

            keep_start_frame = max(0, (next_window * cfg.input_shape.frames_per_window) - overlap_frames)
            drop_frames = keep_start_frame - stage_start_frame
            if drop_frames > 0:
                drop_bytes = drop_frames * cfg.sizing.frame_bytes
                del stage[:drop_bytes]
                stage_start_frame = keep_start_frame

        if cfg.root.streaming_io and chunks.done_bytes != result.nbytes:
            raise RuntimeError(f'streaming source exact precompute length mismatch: bytes={chunks.done_bytes} expected={result.nbytes}')

    if next_window != result.windows:
        raise RuntimeError(f'source exact precompute incomplete: windows={next_window} expected={result.windows}')
    _finish_source_sum_audit(ctx)


def run_source_exact_precompute_pass(ctx, result):
    cfg = ctx.cfg
    if not cfg.source.source_exact_precompute:
        return
    if cfg.source.source_precompute_in_stats:
        return
    if cfg.source.source_precompute_from_channel_sums:
        if not ctx.buffers.d_source_exact_sums.value or not ctx.buffers.d_start_states.value:
            raise RuntimeError('source exact channel-sum precompute buffers are not allocated')
        write_hist4_arg = ctypes.c_uint32(0 if cfg.source.source_channel_hist4_exact else 1)
        write_short_arg = ctypes.c_uint32(0 if (cfg.source.source_channel_short_exact or cfg.source.source_channel_short_boundary or getattr(cfg.source, 'source_channel_short_raw_boundary', False)) else 1)
        args = kernel_args.build_source_exact_from_channel_sums_args(
            ctx.bindings.start_states_arg,
            ctx.bindings.source_exact_sums_arg,
            ctx.bindings.windows_arg,
            ctx.bindings.channels_arg,
            write_hist4_arg,
            write_short_arg,
        )
        grid_windows = min(65535, max(1, (result.windows + 127) // 128))
        stage_t0 = time.perf_counter()
        kernel_dt = launch_timed_kernel(ctx.cuda, 'source-exact-from-channel-sums', ctx.kernels.source_exact_from_channel_sums_fn, args, grid_x=grid_windows, block_x=128)
        result.stats_sums_kernel_time += kernel_dt
        result.stats_sums_wall_time += time.perf_counter() - stage_t0
        needs_source_corrections = bool(
            cfg.source.source_channel_hist4_exact
            or cfg.source.source_channel_hist4_boundary
            or cfg.source.source_channel_short_exact
            or cfg.source.source_channel_short_boundary
            or getattr(cfg.source, 'source_channel_short_raw_boundary', False)
        )
        if not needs_source_corrections:
            ctx.emit_progress('stats_sums', 0.70)
            return
        needs_source_energy = bool(
            cfg.source.source_channel_hist4_exact
            or cfg.source.source_channel_short_exact
            or cfg.source.source_channel_short_boundary
        )
        if needs_source_energy and not ctx.buffers.d_source_energy.value:
            raise RuntimeError('source exact channel-sum correction energy buffer is not allocated')
        if not ctx.buffers.d_source_start_states.value:
            raise RuntimeError('source exact channel-sum correction buffers are not allocated')
        if getattr(cfg.source, 'source_channel_short_raw_boundary', False) and not ctx.buffers.d_source_correction_flags.value:
            raise RuntimeError('source exact channel-sum raw correction flags buffer is not allocated')
        _run_source_exact_precompute_stream(ctx, result)
        return
    if not ctx.buffers.d_source_exact_sums.value or not ctx.buffers.d_source_start_states.value or not ctx.buffers.d_source_energy.value:
        raise RuntimeError('source exact precompute buffers are not allocated')
    _run_source_exact_precompute_stream(ctx, result)
