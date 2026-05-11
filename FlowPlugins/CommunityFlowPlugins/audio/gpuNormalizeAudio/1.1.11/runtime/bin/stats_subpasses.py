from __future__ import annotations

import array
import ctypes
import os
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
        chunk_bytes=cfg.chunk_bytes,
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

    peak_stream = ctypes.c_void_p()
    channel_stream = ctypes.c_void_p()
    use_parallel_peaks = bool(cfg.exact_stats_parallel_peaks and getattr(ctx.cuda, '_has_async_apply_api', False))
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
            chunk_bytes=cfg.chunk_bytes,
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
                    peak_dt = launch_timed_kernel(ctx.cuda, 'window-peaks', ctx.kernels.peak_fn, peak_args, grid_x=peak_grid, block_x=256)
                    channel_dt = launch_timed_kernel(ctx.cuda, 'channel-stats', ctx.kernels.channel_sums_fn, channel_args, grid_x=args.channels)
                    kernel_dt = peak_dt + channel_dt
                result.stats_sums_h2d_time += copy_dt
                result.total_h2d_time += copy_dt
                result.stats_sums_kernel_time += kernel_dt
                result.stats_sums_wall_time += time.perf_counter() - stage_t0
                ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
            if cfg.streaming_io:
                _apply_streaming_size_update(ctx, result, chunks.done_bytes)
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
        chunk_bytes=cfg.chunk_bytes,
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
        chunk_bytes=cfg.chunk_bytes,
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
            stage.extend(bytes(host_view[:chunk.this_bytes]))
            stage_frames = len(stage) // cfg.frame_bytes
            stage_end_frame = stage_start_frame + stage_frames
            final_chunk = (chunk.done_bytes + chunk.this_bytes) >= result.nbytes
            ready_windows = min(result.windows, stage_end_frame // cfg.frames_per_window)
            if final_chunk:
                ready_windows = result.windows

            if ready_windows > next_window:
                stage_bytes = len(stage)
                if stage_bytes > len(ctx.host_io.host_in):
                    raise RuntimeError(f'source exact precompute staging exceeded: need={stage_bytes} capacity={len(ctx.host_io.host_in)}')
                host_view[:stage_bytes] = stage
                input_base_arg = ctypes.c_uint32(stage_start_frame)
                input_frames_arg = ctypes.c_uint32(stage_frames)
                target_start_arg = ctypes.c_uint32(next_window)
                target_windows_arg = ctypes.c_uint32(ready_windows - next_window)
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
                source_args = kernel_args.build_source_exact_sums_args(
                    ctx.bindings.source_energy_arg,
                    ctx.bindings.source_exact_sums_arg,
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
                stage_t0 = time.perf_counter()
                copy_t0 = time.perf_counter()
                chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_in, ctypes.c_void_p(ctx.host_io.host_in_ptr), stage_bytes), 'cuMemcpyHtoD(source exact precompute input)')
                copy_dt = time.perf_counter() - copy_t0
                grid_windows = min(65535, max(1, ((ready_windows - next_window) + 127) // 128))
                energy_windows = (stage_frames + cfg.frames_per_window - 1) // cfg.frames_per_window
                energy_grid = max(1, energy_windows * ctx.args.channels)
                energy_dt = launch_timed_kernel(ctx.cuda, 'source-exact-energy', ctx.kernels.source_energy_fn, energy_args, grid_x=energy_grid, block_x=1)
                sum_dt = launch_timed_kernel(ctx.cuda, 'source-exact-precompute', ctx.kernels.source_exact_sums_fn, source_args, grid_x=grid_windows, block_x=128)
                kernel_dt = energy_dt + sum_dt
                result.stats_sums_h2d_time += copy_dt
                result.total_h2d_time += copy_dt
                result.stats_sums_kernel_time += kernel_dt
                result.stats_sums_wall_time += time.perf_counter() - stage_t0
                next_window = ready_windows
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
