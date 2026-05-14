from __future__ import annotations

import array
import ctypes
import os
import sys
import time

from cuda_driver import chk
from cuda_launch import launch_timed_kernel
import kernel_args
from kweight_state import build_start_states
from stream_io import FrameChunkReader


def env_flag(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value in ('1', 'true', 'TRUE', 'yes', 'YES')


def run_exact_sums_pass(ctx, result):
    args = ctx.args
    cfg = ctx.cfg
    host_in = ctx.host_io.host_in
    host_in_ptr = ctx.host_io.host_in_ptr

    with FrameChunkReader(
        args,
        cfg.streaming_io,
        cfg.decode_command,
        'streaming decode pass 1',
        host_in,
        nbytes=cfg.nbytes,
        chunk_bytes=cfg.stats_chunk_bytes,
        frame_bytes=cfg.frame_bytes,
        partial_frame_error='streaming exact sums ended with a partial frame',
        staging_label='streaming exact sums staging',
        short_read_error='short input read during exact sums',
        alignment_error='streaming exact sums read was not frame-aligned',
    ) as chunks:
        for chunk in chunks:
            frames_arg = ctypes.c_uint32(chunk.this_frames)
            exact_sums_args = kernel_args.build_exact_sums_args(
                ctx.bindings.in_arg,
                ctx.bindings.sums_arg,
                ctx.bindings.exact_sums_state_i_arg,
                ctx.bindings.exact_sums_state_d_arg,
                frames_arg,
                ctx.bindings.channels_arg,
                ctx.bindings.frame_window_arg,
                ctx.bindings.b_arg,
                ctx.bindings.a_arg,
            )
            stage_t0 = time.perf_counter()
            t0 = time.perf_counter()
            chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_in, ctypes.c_void_p(host_in_ptr), chunk.this_bytes), 'cuMemcpyHtoD(exact sums input)')
            copy_dt = time.perf_counter() - t0
            kernel_dt = launch_timed_kernel(ctx.cuda, 'exact-sums', ctx.kernels.exact_sums_fn, exact_sums_args)
            result.stats_sums_h2d_time += copy_dt
            result.total_h2d_time += copy_dt
            result.stats_sums_kernel_time += kernel_dt
            result.stats_sums_wall_time += time.perf_counter() - stage_t0
            ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
        if cfg.streaming_io:
            _apply_streaming_size_update(ctx, result, chunks.done_bytes)
            ctx.emit_progress('stats_sums', 0.70)


def run_channel_stats_pass(ctx, result):
    args = ctx.args
    cfg = ctx.cfg
    host_in = ctx.host_io.host_in
    host_in_ptr = ctx.host_io.host_in_ptr
    source_stage = bytearray() if (cfg.source_precompute_in_stats or cfg.source_channel_hist4_exact or cfg.source_channel_hist4_boundary) else None
    source_stage_start_frame = 0
    next_source_window = 0
    source_overlap_frames = cfg.frames_per_window * 29

    peak_stream = ctypes.c_void_p()
    channel_stream = ctypes.c_void_p()
    use_combined_peaks = bool(cfg.exact_channel_stats_combined_peaks)
    use_parallel_peaks = bool((not use_combined_peaks) and cfg.exact_stats_parallel_peaks and getattr(ctx.cuda, '_has_async_apply_api', False))
    if use_parallel_peaks:
        chk(ctx.cuda.cuStreamCreate(ctypes.byref(peak_stream), 0), 'cuStreamCreate(stats peaks)')
        chk(ctx.cuda.cuStreamCreate(ctypes.byref(channel_stream), 0), 'cuStreamCreate(stats channel)')
    try:
        with FrameChunkReader(
            args,
            cfg.streaming_io,
            cfg.decode_command,
            'streaming decode stats channel',
            host_in,
            nbytes=cfg.nbytes,
            chunk_bytes=cfg.stats_chunk_bytes,
            frame_bytes=cfg.frame_bytes,
            partial_frame_error='streaming channel stats ended with a partial frame',
            staging_label='streaming channel stats staging',
            short_read_error='short input read during channel stats',
        ) as chunks:
            for chunk in chunks:
                this_samples = chunk.this_frames * args.channels
                frames_arg = ctypes.c_uint32(chunk.this_frames)
                frame_offset_arg = ctypes.c_uint32(chunk.frame_offset)
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
                chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_in, ctypes.c_void_p(host_in_ptr), chunk.this_bytes), 'cuMemcpyHtoD(channel stats input)')
                copy_dt = time.perf_counter() - t0
                if use_parallel_peaks:
                    kernel_t0 = time.perf_counter()
                    chk(ctx.cuda.cuLaunchKernel(ctx.kernels.peak_fn, peak_grid, 1, 1, 256, 1, 1, 0, peak_stream, peak_args, None), 'cuLaunchKernel(window-peaks parallel)')
                    chk(ctx.cuda.cuLaunchKernel(ctx.kernels.channel_sums_fn, args.channels, 1, 1, 1, 1, 1, 0, channel_stream, channel_args, None), 'cuLaunchKernel(channel-stats parallel)')
                    chk(ctx.cuda.cuStreamSynchronize(peak_stream), 'cuStreamSynchronize(stats peaks)')
                    chk(ctx.cuda.cuStreamSynchronize(channel_stream), 'cuStreamSynchronize(stats channel)')
                    kernel_dt = time.perf_counter() - kernel_t0
                else:
                    peak_dt = 0.0 if use_combined_peaks else launch_timed_kernel(ctx.cuda, 'window-peaks', ctx.kernels.peak_fn, peak_args, grid_x=peak_grid, block_x=256)
                    channel_dt = launch_timed_kernel(ctx.cuda, 'channel-stats', ctx.kernels.channel_sums_fn, channel_args, grid_x=args.channels)
                    kernel_dt = peak_dt + channel_dt
                result.stats_sums_h2d_time += copy_dt
                result.total_h2d_time += copy_dt
                result.stats_sums_kernel_time += kernel_dt
                result.stats_sums_wall_time += time.perf_counter() - stage_t0
                if source_stage is not None:
                    source_stage.extend(memoryview(host_in)[:chunk.this_bytes])
                    stage_frames = len(source_stage) // cfg.frame_bytes
                    stage_end_frame = source_stage_start_frame + stage_frames
                    full_ready_windows = min(result.windows, stage_end_frame // cfg.frames_per_window)
                    while full_ready_windows - next_source_window >= cfg.source_precompute_windows:
                        ready_windows = next_source_window + cfg.source_precompute_windows
                        next_source_window = _run_source_exact_precompute_stage(
                            ctx,
                            result,
                            source_stage,
                            source_stage_start_frame,
                            next_source_window,
                            ready_windows,
                        )
                        ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
                        source_stage_start_frame = _trim_source_exact_stage(
                            source_stage,
                            source_stage_start_frame,
                            next_source_window,
                            source_overlap_frames,
                            cfg.frame_bytes,
                            cfg.frames_per_window,
                        )
                ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
            if cfg.streaming_io:
                _apply_streaming_size_update(ctx, result, chunks.done_bytes)
            if source_stage is not None:
                if result.windows > next_source_window:
                    next_source_window = _run_source_exact_precompute_stage(
                        ctx,
                        result,
                        source_stage,
                        source_stage_start_frame,
                        next_source_window,
                        result.windows,
                    )
                if next_source_window != result.windows:
                    raise RuntimeError(f'fused source exact precompute incomplete: windows={next_source_window} expected={result.windows}')
                _finish_source_sum_audit(ctx)
            combine_channel_sums(ctx, result, source_arg=ctx.bindings.start_states_arg, label='combine-channel-sums')
            ctx.emit_progress('stats_sums', 0.70)
    finally:
        if channel_stream.value:
            ctx.cuda.cuStreamDestroy_v2(channel_stream)
        if peak_stream.value:
            ctx.cuda.cuStreamDestroy_v2(peak_stream)


def run_q_state_pass(ctx, result):
    args = ctx.args
    cfg = ctx.cfg
    host_in = ctx.host_io.host_in
    host_in_ptr = ctx.host_io.host_in_ptr

    with FrameChunkReader(
        args,
        cfg.streaming_io,
        cfg.decode_command,
        'streaming decode stats q',
        host_in,
        nbytes=cfg.nbytes,
        chunk_bytes=cfg.stats_chunk_bytes,
        frame_bytes=cfg.frame_bytes,
        partial_frame_error='streaming stats q ended with a partial frame',
        staging_label='streaming stats q staging',
        short_read_error='short input read during stats',
    ) as chunks:
        for chunk in chunks:
            frames_arg = ctypes.c_uint32(chunk.this_frames)
            window_offset_arg = ctypes.c_uint32(chunk.frame_offset // cfg.frames_per_window)
            windows_this = (chunk.this_frames + cfg.frames_per_window - 1) // cfg.frames_per_window
            pairs_this = windows_this * args.channels
            grid_pairs = min(65535, max(1, (pairs_this + 255) // 256))
            q_args = kernel_args.build_q_args(
                ctx.bindings.in_arg,
                ctx.bindings.q_states_arg,
                ctx.bindings.peaks_arg,
                frames_arg,
                ctx.bindings.channels_arg,
                ctx.bindings.frame_window_arg,
                window_offset_arg,
                ctx.bindings.a_arg,
            )
            stage_t0 = time.perf_counter()
            t0 = time.perf_counter()
            chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_in, ctypes.c_void_p(host_in_ptr), chunk.this_bytes), 'cuMemcpyHtoD(stats input)')
            copy_dt = time.perf_counter() - t0
            kernel_dt = launch_timed_kernel(ctx.cuda, 'q-states', ctx.kernels.q_fn, q_args, grid_x=grid_pairs, block_x=256)
            result.stats_q_h2d_time += copy_dt
            result.total_h2d_time += copy_dt
            result.stats_q_kernel_time += kernel_dt
            result.stats_q_wall_time += time.perf_counter() - stage_t0
            ctx.emit_progress('stats_q', 0.35 * (chunks.done_bytes / float(cfg.nbytes)))
        if cfg.streaming_io:
            _apply_streaming_size_update(ctx, result, chunks.done_bytes)
            result.state_bytes = result.windows * args.channels * 4 * 8
            ctx.emit_progress('stats_q', 0.35)


def build_prefix_start_states(ctx, result):
    args = ctx.args
    t0 = time.perf_counter()
    if env_flag('LOUDNORM_GPU_PREFIX_STATE_DEVICE'):
        windows_arg = ctypes.c_uint32(result.windows)
        total_frames_arg = ctypes.c_uint32(result.total_frames)
        start_args = kernel_args.build_prefix_start_state_args(
            ctx.bindings.q_states_arg,
            ctx.bindings.start_states_arg,
            windows_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            total_frames_arg,
            ctx.bindings.a_arg,
        )
        kernel_dt = launch_timed_kernel(ctx.cuda, 'prefix-start-states-device', ctx.kernels.prefix_start_states_fn, start_args, grid_x=args.channels, block_x=1)
        result.host_prefix_cpu_time += kernel_dt
        result.host_prefix_wall_time += time.perf_counter() - t0
        return
    q_states = array.array('d', [0.0]) * (result.windows * args.channels * 4)
    copy_t0 = time.perf_counter()
    chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(q_states.buffer_info()[0]), ctx.buffers.d_q_states, result.state_bytes), 'cuMemcpyDtoH(q_states)')
    copy_dt = time.perf_counter() - copy_t0
    result.host_prefix_d2h_time += copy_dt
    result.total_d2h_time += copy_dt
    cpu_t0 = time.perf_counter()
    start_states = build_start_states(q_states, result.windows, args.channels, ctx.cfg.frames_per_window, result.total_frames, ctx.a_coeffs)
    result.host_prefix_cpu_time += time.perf_counter() - cpu_t0
    copy_t0 = time.perf_counter()
    chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_start_states, ctypes.c_void_p(start_states.buffer_info()[0]), result.state_bytes), 'cuMemcpyHtoD(start_states)')
    copy_dt = time.perf_counter() - copy_t0
    result.host_prefix_h2d_time += copy_dt
    result.total_h2d_time += copy_dt
    result.host_prefix_wall_time += time.perf_counter() - t0


def run_sums_pass(ctx, result):
    args = ctx.args
    cfg = ctx.cfg
    host_in = ctx.host_io.host_in
    host_in_ptr = ctx.host_io.host_in_ptr

    with FrameChunkReader(
        args,
        cfg.streaming_io,
        cfg.decode_command,
        'streaming decode stats sums',
        host_in,
        nbytes=result.nbytes,
        chunk_bytes=cfg.stats_chunk_bytes,
        frame_bytes=cfg.frame_bytes,
        partial_frame_error='streaming stats sums ended with a partial frame',
        staging_label='streaming stats sums staging',
        short_read_error='short input read during sums',
        limit_kind='expected',
        limit_label='streaming stats sums',
    ) as chunks:
        for chunk in chunks:
            frames_arg = ctypes.c_uint32(chunk.this_frames)
            window_offset_arg = ctypes.c_uint32(chunk.frame_offset // cfg.frames_per_window)
            windows_this = (chunk.this_frames + cfg.frames_per_window - 1) // cfg.frames_per_window
            pairs_this = windows_this * args.channels
            grid_pairs = min(65535, max(1, (pairs_this + 255) // 256))
            if cfg.exact_prefix_channel_stats:
                sums_args = kernel_args.build_sums_args(
                    ctx.bindings.in_arg,
                    ctx.bindings.channel_sums_arg,
                    ctx.bindings.start_states_arg,
                    frames_arg,
                    ctx.bindings.channels_arg,
                    ctx.bindings.frame_window_arg,
                    window_offset_arg,
                    ctx.bindings.b_arg,
                    ctx.bindings.a_arg,
                )
                sums_kernel_fn = ctx.kernels.prefix_channel_sums_fn
                sums_label = 'prefix-channel-sums'
            else:
                sums_args = kernel_args.build_sums_args(
                    ctx.bindings.in_arg,
                    ctx.bindings.sums_arg,
                    ctx.bindings.start_states_arg,
                    frames_arg,
                    ctx.bindings.channels_arg,
                    ctx.bindings.frame_window_arg,
                    window_offset_arg,
                    ctx.bindings.b_arg,
                    ctx.bindings.a_arg,
                )
                sums_kernel_fn = ctx.kernels.sums_fn
                sums_label = 'sums'
            stage_t0 = time.perf_counter()
            t0 = time.perf_counter()
            chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_in, ctypes.c_void_p(host_in_ptr), chunk.this_bytes), 'cuMemcpyHtoD(sums input)')
            copy_dt = time.perf_counter() - t0
            kernel_dt = launch_timed_kernel(ctx.cuda, sums_label, sums_kernel_fn, sums_args, grid_x=grid_pairs, block_x=256)
            result.stats_sums_h2d_time += copy_dt
            result.total_h2d_time += copy_dt
            result.stats_sums_kernel_time += kernel_dt
            result.stats_sums_wall_time += time.perf_counter() - stage_t0
            ctx.emit_progress('stats_sums', 0.35 + 0.35 * (chunks.done_bytes / float(result.nbytes)))
        if cfg.streaming_io and chunks.done_bytes != result.nbytes:
            raise RuntimeError(f'streaming stats sums length mismatch: bytes={chunks.done_bytes} expected={result.nbytes}')


def combine_channel_sums(ctx, result, *, source_arg, label):
    combine_windows_arg = ctypes.c_uint32(result.windows)
    combine_args = kernel_args.build_combine_sums_args(source_arg, ctx.bindings.sums_arg, combine_windows_arg, ctx.bindings.channels_arg)
    grid_windows = min(65535, max(1, (result.windows + 255) // 256))
    stage_t0 = time.perf_counter()
    kernel_dt = launch_timed_kernel(ctx.cuda, label, ctx.kernels.combine_sums_fn, combine_args, grid_x=grid_windows, block_x=256)
    result.stats_sums_kernel_time += kernel_dt
    result.stats_sums_wall_time += time.perf_counter() - stage_t0


def run_source_exact_precompute_pass(ctx, result):
    cfg = ctx.cfg
    if not cfg.source_exact_precompute:
        return
    if cfg.source_precompute_in_stats:
        return
    if cfg.source_precompute_from_channel_sums:
        if not ctx.buffers.d_source_exact_sums.value or not ctx.buffers.d_start_states.value:
            raise RuntimeError('source exact channel-sum precompute buffers are not allocated')
        write_hist4_arg = ctypes.c_uint32(0 if cfg.source_channel_hist4_exact else 1)
        args = kernel_args.build_source_exact_from_channel_sums_args(
            ctx.bindings.start_states_arg,
            ctx.bindings.source_exact_sums_arg,
            ctx.bindings.windows_arg,
            ctx.bindings.channels_arg,
            write_hist4_arg,
        )
        grid_windows = min(65535, max(1, (result.windows + 127) // 128))
        stage_t0 = time.perf_counter()
        kernel_dt = launch_timed_kernel(ctx.cuda, 'source-exact-from-channel-sums', ctx.kernels.source_exact_from_channel_sums_fn, args, grid_x=grid_windows, block_x=128)
        result.stats_sums_kernel_time += kernel_dt
        result.stats_sums_wall_time += time.perf_counter() - stage_t0
        ctx.emit_progress('stats_sums', 0.70)
        return
    if not ctx.buffers.d_source_exact_sums.value or not ctx.buffers.d_source_start_states.value or not ctx.buffers.d_source_energy.value:
        raise RuntimeError('source exact precompute buffers are not allocated')

    host_view = memoryview(ctx.host_io.host_in)
    stage = bytearray()
    stage_start_frame = 0
    next_window = 0
    overlap_frames = cfg.frames_per_window * 29

    with FrameChunkReader(
        ctx.args,
        cfg.streaming_io,
        cfg.decode_command,
        'streaming source exact precompute',
        ctx.host_io.host_in,
        nbytes=result.nbytes,
        chunk_bytes=cfg.source_precompute_chunk_bytes,
        frame_bytes=cfg.frame_bytes,
        partial_frame_error='streaming source exact precompute ended with a partial frame',
        staging_label='streaming source exact precompute staging',
        short_read_error='short input read during source exact precompute',
        limit_kind='expected',
        limit_label='streaming source exact precompute',
    ) as chunks:
        for chunk in chunks:
            stage.extend(host_view[:chunk.this_bytes])
            stage_frames = len(stage) // cfg.frame_bytes
            stage_end_frame = stage_start_frame + stage_frames
            final_chunk = (chunk.done_bytes + chunk.this_bytes) >= result.nbytes
            ready_windows = min(result.windows, stage_end_frame // cfg.frames_per_window)
            if final_chunk:
                ready_windows = result.windows

            if ready_windows > next_window:
                next_window = _run_source_exact_precompute_stage(ctx, result, stage, stage_start_frame, next_window, ready_windows)
                ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(result.nbytes)))

            keep_start_frame = max(0, (next_window * cfg.frames_per_window) - overlap_frames)
            drop_frames = keep_start_frame - stage_start_frame
            if drop_frames > 0:
                drop_bytes = drop_frames * cfg.frame_bytes
                del stage[:drop_bytes]
                stage_start_frame = keep_start_frame

        if cfg.streaming_io and chunks.done_bytes != result.nbytes:
            raise RuntimeError(f'streaming source exact precompute length mismatch: bytes={chunks.done_bytes} expected={result.nbytes}')

    if next_window != result.windows:
        raise RuntimeError(f'source exact precompute incomplete: windows={next_window} expected={result.windows}')
    _finish_source_sum_audit(ctx)

def _run_source_exact_precompute_stage(ctx, result, stage, stage_start_frame, next_window, ready_windows):
    cfg = ctx.cfg
    if ready_windows <= next_window:
        return next_window
    stage_frames = len(stage) // cfg.frame_bytes
    needed_end_frame = result.total_frames if ready_windows >= result.windows else ready_windows * cfg.frames_per_window
    copy_frames = min(stage_frames, max(0, needed_end_frame - stage_start_frame))
    stage_bytes = copy_frames * cfg.frame_bytes
    if stage_bytes > len(ctx.host_io.host_in):
        raise RuntimeError(f'source exact precompute staging exceeded: need={stage_bytes} capacity={len(ctx.host_io.host_in)}')
    input_base_arg = ctypes.c_uint32(stage_start_frame)
    input_frames_arg = ctypes.c_uint32(copy_frames)
    target_start_arg = ctypes.c_uint32(next_window)
    target_windows_arg = ctypes.c_uint32(ready_windows - next_window)
    stage_t0 = time.perf_counter()
    copy_dt = 0.0
    memoryview(ctx.host_io.host_in)[:stage_bytes] = memoryview(stage)[:stage_bytes]
    copy_t0 = time.perf_counter()
    chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_in, ctypes.c_void_p(ctx.host_io.host_in_ptr), stage_bytes), 'cuMemcpyHtoD(source exact precompute input)')
    copy_dt = time.perf_counter() - copy_t0
    grid_windows = min(65535, max(1, ((ready_windows - next_window) + 127) // 128))
    kernel_dt = 0.0
    if ctx.cfg.source_channel_hist4_boundary:
        boundary_margin_ratio_arg = ctypes.c_double(ctx.cfg.source_channel_hist4_margin_ratio)
        hist4_args = kernel_args.build_source_selective_hist4_sums_args(
            ctx.bindings.in_arg,
            ctx.bindings.source_start_states_arg,
            ctx.bindings.source_exact_sums_arg,
            ctx.bindings.start_states_arg,
            ctx.bindings.hist_boundaries_arg,
            ctx.bindings.total_frames_arg,
            input_base_arg,
            input_frames_arg,
            target_start_arg,
            target_windows_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.windows_arg,
            ctx.bindings.b_arg,
            ctx.bindings.a_arg,
            boundary_margin_ratio_arg,
        )
        kernel_dt += launch_timed_kernel(ctx.cuda, 'source-selective-hist4-precompute', ctx.kernels.source_selective_hist4_sums_fn, hist4_args, grid_x=grid_windows, block_x=128)
    elif ctx.cfg.source_channel_hist4_exact:
        energy_args = kernel_args.build_source_energy_args(
            ctx.bindings.in_arg,
            ctx.bindings.source_energy_arg,
            ctx.bindings.source_start_states_arg,
            ctx.bindings.total_frames_arg,
            input_base_arg,
            input_frames_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.b_arg,
            ctx.bindings.a_arg,
        )
        energy_windows = (copy_frames + cfg.frames_per_window - 1) // cfg.frames_per_window
        energy_grid = max(1, energy_windows * ctx.args.channels)
        kernel_dt += launch_timed_kernel(ctx.cuda, 'source-exact-energy', ctx.kernels.source_energy_fn, energy_args, grid_x=energy_grid, block_x=1)
        null_arg = ctypes.c_uint64(0)
        selective_boundary_arg = ctypes.c_uint32(0)
        boundary_margin_ratio_arg = ctypes.c_double(ctx.cfg.source_channel_hist4_margin_ratio)
        hist4_args = kernel_args.build_source_exact_hist4_sums_args(
            ctx.bindings.source_energy_arg,
            ctx.bindings.source_exact_sums_arg,
            null_arg,
            null_arg,
            ctx.bindings.total_frames_arg,
            input_base_arg,
            input_frames_arg,
            target_start_arg,
            target_windows_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.windows_arg,
            boundary_margin_ratio_arg,
            selective_boundary_arg,
        )
        kernel_dt += launch_timed_kernel(ctx.cuda, 'source-exact-hist4-precompute', ctx.kernels.source_exact_hist4_sums_fn, hist4_args, grid_x=grid_windows, block_x=128)
    elif not ctx.cfg.source_precompute_from_channel_sums:
        energy_args = kernel_args.build_source_energy_args(
            ctx.bindings.in_arg,
            ctx.bindings.source_energy_arg,
            ctx.bindings.source_start_states_arg,
            ctx.bindings.total_frames_arg,
            input_base_arg,
            input_frames_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.b_arg,
            ctx.bindings.a_arg,
        )
        energy_windows = (copy_frames + cfg.frames_per_window - 1) // cfg.frames_per_window
        energy_grid = max(1, energy_windows * ctx.args.channels)
        kernel_dt += launch_timed_kernel(ctx.cuda, 'source-exact-energy', ctx.kernels.source_energy_fn, energy_args, grid_x=energy_grid, block_x=1)
        source_args = kernel_args.build_source_exact_sums_args(
            ctx.bindings.source_energy_arg,
            _source_exact_output_arg(ctx),
            ctx.bindings.source_start_states_arg,
            ctx.bindings.total_frames_arg,
            input_base_arg,
            input_frames_arg,
            target_start_arg,
            target_windows_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.windows_arg,
            ctx.bindings.b_arg,
            ctx.bindings.a_arg,
        )
        if ctx.cfg.source_sum_audit or not ctx.cfg.source_block_sums:
            kernel_dt += launch_timed_kernel(ctx.cuda, 'source-exact-precompute', ctx.kernels.source_exact_sums_fn, source_args, grid_x=grid_windows, block_x=128)
    if (not ctx.cfg.source_channel_hist4_exact) and ctx.cfg.source_block_sum_candidate:
        block_frames_arg = ctypes.c_uint32(ctx.cfg.source_block_frames)
        block_count = (copy_frames + ctx.cfg.source_block_frames - 1) // ctx.cfg.source_block_frames
        block_count_arg = ctypes.c_uint32(block_count)
        block_pairs = max(1, block_count * ctx.args.channels)
        block_grid = min(65535, max(1, (block_pairs + 255) // 256))
        block_args = kernel_args.build_source_block_sums_args(
            ctx.bindings.source_energy_arg,
            ctx.bindings.source_block_sums_arg,
            input_frames_arg,
            ctx.bindings.channels_arg,
            block_frames_arg,
        )
        block_prefix_args = kernel_args.build_source_block_prefix_sums_args(
            ctx.bindings.source_block_sums_arg,
            block_count_arg,
            ctx.bindings.channels_arg,
        )
        block_exact_args = kernel_args.build_source_block_exact_sums_args(
            ctx.bindings.source_energy_arg,
            ctx.bindings.source_block_sums_arg,
            _source_block_output_arg(ctx),
            ctx.bindings.total_frames_arg,
            input_base_arg,
            input_frames_arg,
            target_start_arg,
            target_windows_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.windows_arg,
            block_frames_arg,
        )
        kernel_dt += launch_timed_kernel(ctx.cuda, 'source-block-sums', ctx.kernels.source_block_sums_fn, block_args, grid_x=block_grid, block_x=256)
        kernel_dt += launch_timed_kernel(ctx.cuda, 'source-block-prefix-sums', ctx.kernels.source_block_prefix_sums_fn, block_prefix_args, grid_x=ctx.args.channels, block_x=1)
        kernel_dt += launch_timed_kernel(ctx.cuda, 'source-block-precompute', ctx.kernels.source_block_exact_sums_fn, block_exact_args, grid_x=grid_windows, block_x=128)
    result.stats_sums_h2d_time += copy_dt
    result.total_h2d_time += copy_dt
    result.stats_sums_kernel_time += kernel_dt
    result.stats_sums_wall_time += time.perf_counter() - stage_t0
    if ctx.cfg.source_sum_audit:
        _audit_source_sums_stage(ctx, result, next_window, ready_windows - next_window)
    return ready_windows


def _source_exact_output_arg(ctx):
    if ctx.cfg.source_sum_audit and ctx.cfg.source_block_sums:
        return ctx.bindings.source_exact_audit_sums_arg
    return ctx.bindings.source_exact_sums_arg


def _source_block_output_arg(ctx):
    if ctx.cfg.source_block_sums:
        return ctx.bindings.source_exact_sums_arg
    return ctx.bindings.source_exact_audit_sums_arg


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


def _trim_source_exact_stage(stage, stage_start_frame, next_window, overlap_frames, frame_bytes, frames_per_window):
    keep_start_frame = max(0, (next_window * frames_per_window) - overlap_frames)
    drop_frames = keep_start_frame - stage_start_frame
    if drop_frames > 0:
        drop_bytes = drop_frames * frame_bytes
        del stage[:drop_bytes]
        stage_start_frame = keep_start_frame
    return stage_start_frame


def _apply_streaming_size_update(ctx, result, done_bytes):
    if done_bytes <= 0:
        raise RuntimeError('empty streaming input during stats')
    result.nbytes = done_bytes
    result.mib = done_bytes / (1024 * 1024)
    result.total_samples = done_bytes // ctx.cfg.input_sample_bytes
    if result.total_samples % ctx.args.channels:
        raise RuntimeError('streaming input sample count must be divisible by channels')
    result.total_frames = result.total_samples // ctx.args.channels
    result.windows = (result.total_frames + ctx.cfg.frames_per_window - 1) // ctx.cfg.frames_per_window
    result.seconds = result.total_frames / float(ctx.args.rate)
