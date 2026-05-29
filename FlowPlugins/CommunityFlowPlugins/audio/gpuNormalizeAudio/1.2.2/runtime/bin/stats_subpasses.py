from __future__ import annotations

import array
import ctypes
import math
import os
import struct
import sys
import time

from cuda_driver import chk
from cuda_launch import launch_kernel, launch_timed_kernel
import kernel_args
from kweight_state import build_start_states
from loudnorm_math import input_loudness_range_from_window_sums, input_loudness_threshold_from_window_sums
from runtime_profile import format_profile_stage
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
    use_source_device_energy = bool(cfg.source_precompute_device_energy)
    use_source_device_input = bool(getattr(cfg, 'source_precompute_device_input', False))
    use_source_fixed_buffer = bool(getattr(cfg, 'source_stage_fixed_buffer', False)) and not (use_source_device_energy or use_source_device_input)
    source_stage_needed = bool(cfg.source_precompute_in_stats or cfg.source_channel_hist4_exact or cfg.source_channel_hist4_boundary or cfg.source_channel_short_exact or cfg.source_channel_short_boundary)
    if use_source_device_energy or use_source_device_input or not source_stage_needed:
        source_stage = None
    elif use_source_fixed_buffer:
        source_stage = bytearray(cfg.source_precompute_stage_bytes)
    else:
        source_stage = bytearray()
    source_stage_active_bytes = 0
    audit_tail = bytearray() if (cfg.audit_ffmpeg_input_metrics or cfg.emit_first_pass_json) else None
    source_stage_start_frame = 0
    source_energy_stage_end_frame = 0
    source_input_stage_end_frame = 0
    next_source_window = 0
    source_overlap_frames = cfg.frames_per_window * 29
    source_energy_capacity_frames = cfg.source_precompute_stage_bytes // cfg.frame_bytes if use_source_device_energy else 0
    source_input_capacity_frames = cfg.source_precompute_stage_bytes // cfg.frame_bytes if use_source_device_input else 0

    peak_stream = ctypes.c_void_p()
    channel_stream = ctypes.c_void_p()
    use_combined_peaks = bool(cfg.exact_channel_stats_combined_peaks)
    use_parallel_peaks = bool((not use_combined_peaks) and cfg.exact_stats_parallel_peaks and getattr(ctx.cuda, '_has_async_apply_api', False))
    use_async_pipeline = bool(
        cfg.exact_stats_async_pipeline
        and getattr(ctx.cuda, '_has_async_apply_api', False)
        and not use_parallel_peaks
        and not use_combined_peaks
        and not getattr(ctx.host_io, 'pinned', 0)
        and ctx.buffers.d_stats_in_b.value
    )
    stats_streams = []
    stats_pending = []
    stats_host_buffers = []
    stats_host_ptrs = []
    last_stats_stream_idx = None
    direct_stats_bytearray_payload = bool(getattr(cfg, 'stats_prefetch_bytearray_direct_h2d', False) and not use_async_pipeline)
    direct_stats_bytes_payload = bool(getattr(cfg, 'stats_prefetch_direct_h2d', False) and not use_async_pipeline and not direct_stats_bytearray_payload)

    def sync_async_stats(label):
        if not use_async_pipeline:
            return
        for idx, stream in enumerate(stats_streams):
            if not stats_pending[idx]:
                continue
            sync_t0 = time.perf_counter()
            chk(ctx.cuda.cuStreamSynchronize(stream), f'cuStreamSynchronize({label} {idx})')
            result.stats_sums_wall_time += time.perf_counter() - sync_t0
            stats_pending[idx] = False

    if use_parallel_peaks:
        chk(ctx.cuda.cuStreamCreate(ctypes.byref(peak_stream), 0), 'cuStreamCreate(stats peaks)')
        chk(ctx.cuda.cuStreamCreate(ctypes.byref(channel_stream), 0), 'cuStreamCreate(stats channel)')
    elif use_async_pipeline:
        for idx in range(2):
            stream = ctypes.c_void_p()
            chk(ctx.cuda.cuStreamCreate(ctypes.byref(stream), 0), f'cuStreamCreate(stats async {idx})')
            stats_streams.append(stream)
            stats_pending.append(False)
            stage_buffer = bytearray(len(host_in))
            stats_host_buffers.append(stage_buffer)
            stats_host_ptrs.append(ctypes.addressof(ctypes.c_char.from_buffer(stage_buffer)))
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
            direct_payload=direct_stats_bytes_payload,
            direct_bytearray_payload=direct_stats_bytearray_payload,
        ) as chunks:
            chunk_index = 0
            for chunk in chunks:
                async_slot = chunk_index & 1
                if use_async_pipeline and stats_pending[async_slot]:
                    sync_t0 = time.perf_counter()
                    chk(ctx.cuda.cuStreamSynchronize(stats_streams[async_slot]), f'cuStreamSynchronize(stats async reuse {async_slot})')
                    result.stats_sums_wall_time += time.perf_counter() - sync_t0
                    stats_pending[async_slot] = False
                input_arg = ctx.bindings.in_arg
                input_ptr = ctx.buffers.d_in
                if use_async_pipeline and async_slot == 1:
                    input_arg = ctypes.c_uint64(ctx.buffers.d_stats_in_b.value)
                    input_ptr = ctx.buffers.d_stats_in_b
                elif use_source_device_input:
                    source_stage_frames = (chunk.frame_offset + chunk.this_frames) - source_stage_start_frame
                    if source_stage_frames > source_input_capacity_frames:
                        raise RuntimeError(f'source input staging exceeded: need_frames={source_stage_frames} capacity_frames={source_input_capacity_frames}')
                    source_stage_offset_frames = chunk.frame_offset - source_stage_start_frame
                    if source_stage_offset_frames < 0:
                        raise RuntimeError(f'source input staging underflow: chunk_frame={chunk.frame_offset} stage_start={source_stage_start_frame}')
                    input_ptr = ctypes.c_void_p(ctx.buffers.d_in.value + (source_stage_offset_frames * cfg.frame_bytes))
                    input_arg = ctypes.c_uint64(input_ptr.value)
                this_samples = chunk.this_frames * args.channels
                frames_arg = ctypes.c_uint32(chunk.this_frames)
                frame_offset_arg = ctypes.c_uint32(chunk.frame_offset)
                channel_peaks_arg = ctx.bindings.peaks_arg if use_combined_peaks else ctypes.c_uint64(0)
                if use_source_device_energy:
                    source_stage_frames = (chunk.frame_offset + chunk.this_frames) - source_stage_start_frame
                    if source_stage_frames > source_energy_capacity_frames:
                        raise RuntimeError(f'source energy staging exceeded: need_frames={source_stage_frames} capacity_frames={source_energy_capacity_frames}')
                    source_energy_base_arg = ctypes.c_uint32(source_stage_start_frame)
                    source_energy_frames_arg = ctypes.c_uint32(source_energy_capacity_frames)
                    channel_args = kernel_args.build_channel_stats_source_energy_args(
                        input_arg,
                        ctx.bindings.start_states_arg,
                        channel_peaks_arg,
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
                else:
                    channel_args = kernel_args.build_channel_stats_args(
                        input_arg,
                        ctx.bindings.start_states_arg,
                        channel_peaks_arg,
                        ctx.bindings.q_states_arg,
                        ctx.bindings.source_start_states_arg,
                        frames_arg,
                        ctx.bindings.channels_arg,
                        ctx.bindings.frame_window_arg,
                        frame_offset_arg,
                        ctx.bindings.b_arg,
                        ctx.bindings.a_arg,
                    )
                channel_kernel_fn = ctx.kernels.channel_sums_source_energy_fn if use_source_device_energy else ctx.kernels.channel_sums_fn
                peak_args = kernel_args.build_peak_args(
                    input_arg,
                    ctx.bindings.peaks_arg,
                    frames_arg,
                    ctx.bindings.channels_arg,
                    ctx.bindings.frame_window_arg,
                    frame_offset_arg,
                )
                peak_grid = min(65535, max(1, (this_samples + 255) // 256))
                chunk_input_ptr = host_in_ptr
                chunk_view = None
                if getattr(chunk, 'payload_ptr', 0):
                    chunk_input_ptr = chunk.payload_ptr
                    chunk_view = memoryview(chunk.payload)
                stage_t0 = time.perf_counter()
                t0 = time.perf_counter()
                if use_async_pipeline:
                    stream = stats_streams[async_slot]
                    memoryview(stats_host_buffers[async_slot])[:chunk.this_bytes] = memoryview(host_in)[:chunk.this_bytes]
                    chk(ctx.cuda.cuMemcpyHtoDAsync_v2(input_ptr, ctypes.c_void_p(stats_host_ptrs[async_slot]), chunk.this_bytes, stream), 'cuMemcpyHtoDAsync(channel stats input)')
                else:
                    chk(ctx.cuda.cuMemcpyHtoD_v2(input_ptr, ctypes.c_void_p(chunk_input_ptr), chunk.this_bytes), 'cuMemcpyHtoD(channel stats input)')
                copy_dt = time.perf_counter() - t0
                if use_parallel_peaks:
                    kernel_t0 = time.perf_counter()
                    chk(ctx.cuda.cuLaunchKernel(ctx.kernels.peak_fn, peak_grid, 1, 1, 256, 1, 1, 0, peak_stream, peak_args, None), 'cuLaunchKernel(window-peaks parallel)')
                    chk(ctx.cuda.cuLaunchKernel(channel_kernel_fn, args.channels, 1, 1, 1, 1, 1, 0, channel_stream, channel_args, None), 'cuLaunchKernel(channel-stats parallel)')
                    chk(ctx.cuda.cuStreamSynchronize(peak_stream), 'cuStreamSynchronize(stats peaks)')
                    chk(ctx.cuda.cuStreamSynchronize(channel_stream), 'cuStreamSynchronize(stats channel)')
                    kernel_dt = time.perf_counter() - kernel_t0
                elif use_async_pipeline:
                    kernel_t0 = time.perf_counter()
                    if last_stats_stream_idx is not None and stats_pending[last_stats_stream_idx]:
                        chk(ctx.cuda.cuStreamSynchronize(stats_streams[last_stats_stream_idx]), f'cuStreamSynchronize(stats async ordered {last_stats_stream_idx})')
                        stats_pending[last_stats_stream_idx] = False
                    launch_kernel(ctx.cuda, 'window-peaks-async', ctx.kernels.peak_fn, peak_args, grid_x=peak_grid, block_x=256, stream=stats_streams[async_slot])
                    launch_kernel(ctx.cuda, 'channel-stats-async', channel_kernel_fn, channel_args, grid_x=args.channels, stream=stats_streams[async_slot])
                    stats_pending[async_slot] = True
                    last_stats_stream_idx = async_slot
                    kernel_dt = time.perf_counter() - kernel_t0
                elif cfg.exact_stats_fast_launch:
                    kernel_t0 = time.perf_counter()
                    if not use_combined_peaks:
                        launch_kernel(ctx.cuda, 'window-peaks-fast', ctx.kernels.peak_fn, peak_args, grid_x=peak_grid, block_x=256)
                    launch_kernel(ctx.cuda, 'channel-stats-fast', channel_kernel_fn, channel_args, grid_x=args.channels)
                    kernel_dt = time.perf_counter() - kernel_t0
                else:
                    peak_dt = 0.0 if use_combined_peaks else launch_timed_kernel(ctx.cuda, 'window-peaks', ctx.kernels.peak_fn, peak_args, grid_x=peak_grid, block_x=256)
                    channel_dt = launch_timed_kernel(ctx.cuda, 'channel-stats', channel_kernel_fn, channel_args, grid_x=args.channels)
                    kernel_dt = peak_dt + channel_dt
                result.stats_sums_h2d_time += copy_dt
                result.total_h2d_time += copy_dt
                result.stats_sums_kernel_time += kernel_dt
                result.stats_sums_wall_time += time.perf_counter() - stage_t0
                if chunk_view is None:
                    chunk_view = memoryview(host_in)[:chunk.this_bytes]
                if audit_tail is not None:
                    audit_tail.extend(chunk_view)
                    excess = len(audit_tail) - cfg.audit_input_tail_bytes
                    if excess > 0:
                        del audit_tail[:excess]
                if use_source_device_energy:
                    source_energy_stage_end_frame = chunk.frame_offset + chunk.this_frames
                    full_ready_windows = min(result.windows, source_energy_stage_end_frame // cfg.frames_per_window)
                    while full_ready_windows - next_source_window >= cfg.source_precompute_windows:
                        sync_async_stats('stats async source device precompute')
                        ready_windows = next_source_window + cfg.source_precompute_windows
                        next_source_window = _run_source_exact_precompute_stage(
                            ctx,
                            result,
                            None,
                            source_stage_start_frame,
                            next_source_window,
                            ready_windows,
                            device_energy_end_frame=source_energy_stage_end_frame,
                        )
                        ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
                        source_stage_start_frame = _trim_source_energy_stage(
                            ctx,
                            source_stage_start_frame,
                            source_energy_stage_end_frame,
                            next_source_window,
                            source_overlap_frames,
                        )
                elif use_source_device_input:
                    source_input_stage_end_frame = chunk.frame_offset + chunk.this_frames
                    full_ready_windows = min(result.windows, source_input_stage_end_frame // cfg.frames_per_window)
                    while full_ready_windows - next_source_window >= cfg.source_precompute_windows:
                        ready_windows = next_source_window + cfg.source_precompute_windows
                        next_source_window = _run_source_exact_precompute_stage(
                            ctx,
                            result,
                            None,
                            source_stage_start_frame,
                            next_source_window,
                            ready_windows,
                            device_input_end_frame=source_input_stage_end_frame,
                        )
                        ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
                        source_stage_start_frame = _trim_source_input_device_stage(
                            ctx,
                            source_stage_start_frame,
                            source_input_stage_end_frame,
                            next_source_window,
                            source_overlap_frames,
                        )
                elif source_stage is not None:
                    if use_source_fixed_buffer:
                        next_stage_bytes = source_stage_active_bytes + chunk.this_bytes
                        if next_stage_bytes > len(source_stage):
                            raise RuntimeError(f'source fixed staging exceeded: need={next_stage_bytes} capacity={len(source_stage)}')
                        memoryview(source_stage)[source_stage_active_bytes:next_stage_bytes] = chunk_view
                        source_stage_active_bytes = next_stage_bytes
                        stage_frames = source_stage_active_bytes // cfg.frame_bytes
                    else:
                        source_stage.extend(chunk_view)
                        stage_frames = len(source_stage) // cfg.frame_bytes
                    stage_end_frame = source_stage_start_frame + stage_frames
                    full_ready_windows = min(result.windows, stage_end_frame // cfg.frames_per_window)
                    while full_ready_windows - next_source_window >= cfg.source_precompute_windows:
                        sync_async_stats('stats async source precompute')
                        ready_windows = next_source_window + cfg.source_precompute_windows
                        next_source_window = _run_source_exact_precompute_stage(
                            ctx,
                            result,
                            source_stage,
                            source_stage_start_frame,
                            next_source_window,
                            ready_windows,
                            stage_active_bytes=source_stage_active_bytes if use_source_fixed_buffer else None,
                        )
                        ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
                        if use_source_fixed_buffer:
                            source_stage_start_frame, source_stage_active_bytes = _trim_source_exact_stage_fixed(
                                source_stage,
                                source_stage_active_bytes,
                                source_stage_start_frame,
                                next_source_window,
                                source_overlap_frames,
                                cfg.frame_bytes,
                                cfg.frames_per_window,
                            )
                        else:
                            source_stage_start_frame = _trim_source_exact_stage(
                                source_stage,
                                source_stage_start_frame,
                                next_source_window,
                                source_overlap_frames,
                                cfg.frame_bytes,
                                cfg.frames_per_window,
                            )
                ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
                chunk_index += 1
            sync_async_stats('stats async final')
            if cfg.streaming_io:
                _apply_streaming_size_update(ctx, result, chunks.done_bytes)
            if use_source_device_energy:
                if result.windows > next_source_window:
                    sync_async_stats('stats async final source device precompute')
                    next_source_window = _run_source_exact_precompute_stage(
                        ctx,
                        result,
                        None,
                        source_stage_start_frame,
                        next_source_window,
                        result.windows,
                        device_energy_end_frame=source_energy_stage_end_frame,
                    )
                if next_source_window != result.windows:
                    raise RuntimeError(f'fused source device precompute incomplete: windows={next_source_window} expected={result.windows}')
                _finish_source_sum_audit(ctx)
            elif use_source_device_input:
                if result.windows > next_source_window:
                    next_source_window = _run_source_exact_precompute_stage(
                        ctx,
                        result,
                        None,
                        source_stage_start_frame,
                        next_source_window,
                        result.windows,
                        device_input_end_frame=source_input_stage_end_frame,
                    )
                if next_source_window != result.windows:
                    raise RuntimeError(f'fused source input precompute incomplete: windows={next_source_window} expected={result.windows}')
                _finish_source_sum_audit(ctx)
            elif source_stage is not None:
                if result.windows > next_source_window:
                    sync_async_stats('stats async final source precompute')
                    next_source_window = _run_source_exact_precompute_stage(
                        ctx,
                        result,
                        source_stage,
                        source_stage_start_frame,
                        next_source_window,
                        result.windows,
                        stage_active_bytes=source_stage_active_bytes if use_source_fixed_buffer else None,
                    )
                if next_source_window != result.windows:
                    raise RuntimeError(f'fused source exact precompute incomplete: windows={next_source_window} expected={result.windows}')
                _finish_source_sum_audit(ctx)
            combine_channel_sums(ctx, result, source_arg=ctx.bindings.start_states_arg, label='combine-channel-sums')
            if audit_tail is not None:
                _audit_ffmpeg_input_metrics(ctx, result, audit_tail)
            ctx.emit_progress('stats_sums', 0.70)
    finally:
        if channel_stream.value:
            ctx.cuda.cuStreamDestroy_v2(channel_stream)
        if peak_stream.value:
            ctx.cuda.cuStreamDestroy_v2(peak_stream)
        for stream in stats_streams:
            if stream.value:
                ctx.cuda.cuStreamDestroy_v2(stream)


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


def _launch_source_precompute_kernel(ctx, label, kernel_fn, launch_args, *, grid_x=1, block_x=1):
    if ctx.cfg.source_precompute_fast_launch:
        t0 = time.perf_counter()
        launch_kernel(ctx.cuda, label, kernel_fn, launch_args, grid_x=grid_x, block_x=block_x)
        return time.perf_counter() - t0
    return launch_timed_kernel(ctx.cuda, label, kernel_fn, launch_args, grid_x=grid_x, block_x=block_x)


def _run_source_exact_precompute_stream(ctx, result):
    cfg = ctx.cfg
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
        write_short_arg = ctypes.c_uint32(0 if (cfg.source_channel_short_exact or cfg.source_channel_short_boundary) else 1)
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
            cfg.source_channel_hist4_exact
            or cfg.source_channel_hist4_boundary
            or cfg.source_channel_short_exact
            or cfg.source_channel_short_boundary
        )
        if not needs_source_corrections:
            ctx.emit_progress('stats_sums', 0.70)
            return
        if not ctx.buffers.d_source_energy.value or not ctx.buffers.d_source_start_states.value:
            raise RuntimeError('source exact channel-sum correction buffers are not allocated')
        _run_source_exact_precompute_stream(ctx, result)
        return
    if not ctx.buffers.d_source_exact_sums.value or not ctx.buffers.d_source_start_states.value or not ctx.buffers.d_source_energy.value:
        raise RuntimeError('source exact precompute buffers are not allocated')
    _run_source_exact_precompute_stream(ctx, result)


def _run_source_exact_precompute_stage(ctx, result, stage, stage_start_frame, next_window, ready_windows, *, device_energy_end_frame=None, device_input_end_frame=None, stage_active_bytes=None):
    cfg = ctx.cfg
    if ready_windows <= next_window:
        return next_window
    using_device_energy = device_energy_end_frame is not None
    using_device_input = device_input_end_frame is not None
    if stage is None and not (using_device_energy or using_device_input):
        raise RuntimeError('source exact precompute missing source stage')
    if using_device_energy and using_device_input:
        raise RuntimeError('source exact precompute cannot use device input and device energy together')
    if using_device_energy:
        stage_frames = max(0, device_energy_end_frame - stage_start_frame)
    elif using_device_input:
        stage_frames = max(0, device_input_end_frame - stage_start_frame)
    else:
        stage_frames = (len(stage) if stage_active_bytes is None else stage_active_bytes) // cfg.frame_bytes
    needed_end_frame = result.total_frames if ready_windows >= result.windows else ready_windows * cfg.frames_per_window
    copy_frames = min(stage_frames, max(0, needed_end_frame - stage_start_frame))
    stage_bytes = copy_frames * cfg.frame_bytes
    if not (using_device_energy or using_device_input) and stage_bytes > len(ctx.host_io.host_in):
        raise RuntimeError(f'source exact precompute staging exceeded: need={stage_bytes} capacity={len(ctx.host_io.host_in)}')
    input_base_arg = ctypes.c_uint32(stage_start_frame)
    input_frames_arg = ctypes.c_uint32(copy_frames)
    target_start_arg = ctypes.c_uint32(next_window)
    target_windows_arg = ctypes.c_uint32(ready_windows - next_window)
    stage_t0 = time.perf_counter()
    copy_dt = 0.0
    if not (using_device_energy or using_device_input):
        copy_t0 = time.perf_counter()
        if getattr(ctx.cfg, 'source_stage_direct_h2d', False) and stage_bytes > 0:
            stage_ptr = ctypes.addressof(ctypes.c_char.from_buffer(stage))
            chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_in, ctypes.c_void_p(stage_ptr), stage_bytes), 'cuMemcpyHtoD(source exact precompute direct input)')
        else:
            memoryview(ctx.host_io.host_in)[:stage_bytes] = memoryview(stage)[:stage_bytes]
            chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_in, ctypes.c_void_p(ctx.host_io.host_in_ptr), stage_bytes), 'cuMemcpyHtoD(source exact precompute input)')
        copy_dt = time.perf_counter() - copy_t0
    grid_windows = min(65535, max(1, ((ready_windows - next_window) + 127) // 128))
    kernel_dt = 0.0
    energy_dt = 0.0
    source_exact_dt = 0.0
    hist4_dt = 0.0
    block_sums_dt = 0.0
    block_prefix_dt = 0.0
    block_exact_dt = 0.0
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
        hist4_dt += launch_timed_kernel(ctx.cuda, 'source-selective-hist4-precompute', ctx.kernels.source_selective_hist4_sums_fn, hist4_args, grid_x=grid_windows, block_x=128)

    if ctx.cfg.source_channel_hist4_exact or ctx.cfg.source_channel_short_exact or ctx.cfg.source_channel_short_boundary:
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
        energy_pairs = max(1, energy_windows * ctx.args.channels)
        if ctx.cfg.source_energy_packed:
            energy_block_x = getattr(ctx.cfg, 'source_energy_packed_block_x', 32)
            energy_grid = min(65535, max(1, (energy_pairs + energy_block_x - 1) // energy_block_x))
            energy_fn = ctx.kernels.source_energy_packed_hoist_fn if getattr(ctx.cfg, 'source_energy_coeff_hoist', False) else ctx.kernels.source_energy_packed_fn
            energy_label = 'source-exact-energy-packed-hoist' if getattr(ctx.cfg, 'source_energy_coeff_hoist', False) else 'source-exact-energy-packed-fast'
            energy_dt += _launch_source_precompute_kernel(ctx, energy_label, energy_fn, energy_args, grid_x=energy_grid, block_x=energy_block_x)
        else:
            energy_dt += _launch_source_precompute_kernel(ctx, 'source-exact-energy-fast', ctx.kernels.source_energy_fn, energy_args, grid_x=energy_pairs, block_x=1)
    if ctx.cfg.source_channel_hist4_exact:
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
        hist4_dt += launch_timed_kernel(ctx.cuda, 'source-exact-hist4-precompute', ctx.kernels.source_exact_hist4_sums_fn, hist4_args, grid_x=grid_windows, block_x=128)
    if ctx.cfg.source_channel_short_exact:
        short_args = kernel_args.build_source_exact_short_sums_args(
            ctx.bindings.source_energy_arg,
            ctx.bindings.source_exact_sums_arg,
            ctx.bindings.total_frames_arg,
            input_base_arg,
            input_frames_arg,
            target_start_arg,
            target_windows_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.windows_arg,
        )
        source_exact_dt += launch_timed_kernel(ctx.cuda, 'source-exact-short-precompute', ctx.kernels.source_exact_short_sums_fn, short_args, grid_x=grid_windows, block_x=128)
    elif ctx.cfg.source_channel_short_boundary:
        short_args = kernel_args.build_source_selective_short_sums_args(
            ctx.bindings.source_energy_arg,
            ctx.bindings.source_exact_sums_arg,
            ctx.bindings.start_states_arg,
            ctx.bindings.hist_energies_arg,
            ctx.bindings.hist_boundaries_arg,
            ctx.bindings.total_frames_arg,
            input_base_arg,
            input_frames_arg,
            target_start_arg,
            target_windows_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.windows_arg,
            ctypes.c_double(ctx.args.measured_thresh if ctx.args.measured_thresh is not None else -70.0),
            ctypes.c_double(ctx.cfg.source_channel_short_margin_lu),
            ctypes.c_uint32(ctx.cfg.source_channel_short_halo_windows),
        )
        source_exact_dt += launch_timed_kernel(ctx.cuda, 'source-selective-short-precompute', ctx.kernels.source_selective_short_sums_fn, short_args, grid_x=1, block_x=1)
    elif not ctx.cfg.source_precompute_from_channel_sums:
        if not using_device_energy:
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
            energy_pairs = max(1, energy_windows * ctx.args.channels)
            if ctx.cfg.source_energy_packed:
                energy_grid = min(65535, max(1, (energy_pairs + 31) // 32))
                energy_dt += _launch_source_precompute_kernel(ctx, 'source-exact-energy-packed', ctx.kernels.source_energy_packed_fn, energy_args, grid_x=energy_grid, block_x=32)
            else:
                energy_dt += _launch_source_precompute_kernel(ctx, 'source-exact-energy', ctx.kernels.source_energy_fn, energy_args, grid_x=energy_pairs, block_x=1)
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
            source_pairs = (ready_windows - next_window) * 2
            source_block_x = getattr(ctx.cfg, 'source_exact_sums_block_x', 128)
            source_grid = min(65535, max(1, (source_pairs + source_block_x - 1) // source_block_x))
            if ctx.cfg.source_exact_split_sums:
                if getattr(ctx.cfg, 'source_exact_split_unroll4', False):
                    source_exact_fn = ctx.kernels.source_exact_split_unroll4_sums_fn
                    source_exact_label = 'source-exact-precompute-split-unroll4'
                elif getattr(ctx.cfg, 'source_exact_split_pointer_walk', False):
                    source_exact_fn = ctx.kernels.source_exact_split_pointer_sums_fn
                    source_exact_label = 'source-exact-precompute-split-pointer'
                elif getattr(ctx.cfg, 'source_exact_split_readonly_loads', False):
                    source_exact_fn = ctx.kernels.source_exact_split_readonly_sums_fn
                    source_exact_label = 'source-exact-precompute-split-readonly'
                else:
                    source_exact_fn = ctx.kernels.source_exact_split_sums_fn
                    source_exact_label = 'source-exact-precompute-split'
            else:
                source_exact_fn = ctx.kernels.source_exact_sums_fn
                source_exact_label = 'source-exact-precompute-fast'
            source_exact_dt += _launch_source_precompute_kernel(ctx, source_exact_label, source_exact_fn, source_args, grid_x=source_grid, block_x=source_block_x)
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
        block_sums_dt += launch_timed_kernel(ctx.cuda, 'source-block-sums', ctx.kernels.source_block_sums_fn, block_args, grid_x=block_grid, block_x=256)
        block_prefix_dt += launch_timed_kernel(ctx.cuda, 'source-block-prefix-sums', ctx.kernels.source_block_prefix_sums_fn, block_prefix_args, grid_x=ctx.args.channels, block_x=1)
        block_exact_dt += launch_timed_kernel(ctx.cuda, 'source-block-precompute', ctx.kernels.source_block_exact_sums_fn, block_exact_args, grid_x=grid_windows, block_x=128)
    kernel_dt = energy_dt + source_exact_dt + hist4_dt + block_sums_dt + block_prefix_dt + block_exact_dt
    source_stage_wall_dt = time.perf_counter() - stage_t0
    result.stats_sums_h2d_time += copy_dt
    result.total_h2d_time += copy_dt
    result.stats_sums_kernel_time += kernel_dt
    result.stats_sums_wall_time += source_stage_wall_dt
    result.source_precompute_stages += 1
    result.source_precompute_wall_time += source_stage_wall_dt
    result.source_precompute_h2d_time += copy_dt
    result.source_precompute_energy_kernel_time += energy_dt
    result.source_precompute_exact_kernel_time += source_exact_dt
    result.source_precompute_hist4_kernel_time += hist4_dt
    result.source_precompute_block_sums_kernel_time += block_sums_dt
    result.source_precompute_block_prefix_kernel_time += block_prefix_dt
    result.source_precompute_block_exact_kernel_time += block_exact_dt
    if ctx.cfg.source_sum_audit:
        _audit_source_sums_stage(ctx, result, next_window, ready_windows - next_window)
    return ready_windows


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
    audit_windows = max(1, (replay_frames + cfg.frames_per_window - 1) // cfg.frames_per_window)
    audit_t0 = time.perf_counter()

    state_i = array.array('I', [0]) * 8
    state_d = array.array('d', [0.0]) * (args.channels * 4 + 1)
    final_states = array.array('d', [0.0]) * (args.channels * 4)
    chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(final_states.buffer_info()[0]), ctx.buffers.d_start_states, len(final_states) * 8), 'cuMemcpyDtoH(input metric final states)')
    state_d[:len(final_states)] = final_states
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

    source_sums = array.array('d', [0.0]) * result.windows
    replay_sums = array.array('d', [0.0]) * audit_windows
    peak_bits = array.array('I', [0]) * result.windows
    d2h_t0 = time.perf_counter()
    chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(source_sums.buffer_info()[0]), ctx.buffers.d_sums, len(source_sums) * 8), 'cuMemcpyDtoH(input metric source sums)')
    chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(replay_sums.buffer_info()[0]), ctx.buffers.d_input_metric_audit_sums, len(replay_sums) * 8), 'cuMemcpyDtoH(input metric replay sums)')
    chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(peak_bits.buffer_info()[0]), ctx.buffers.d_peaks, len(peak_bits) * 4), 'cuMemcpyDtoH(input metric peaks)')
    d2h_dt = time.perf_counter() - d2h_t0
    source_i, source_thresh = input_loudness_threshold_from_window_sums(source_sums, cfg.frames_per_window)
    source_lra = input_loudness_range_from_window_sums(source_sums, cfg.frames_per_window)
    augmented = array.array('d', source_sums)
    augmented.extend(replay_sums)
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
        ('copy_sec', f'{copy_dt:.6f}'),
        ('kernel_sec', f'{kernel_dt:.6f}'),
        ('d2h_sec', f'{d2h_dt:.6f}'),
        ('wall_sec', f'{(time.perf_counter() - audit_t0):.6f}'),
    ]), file=sys.stderr)


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


def _trim_source_energy_stage(ctx, stage_start_frame, stage_end_frame, next_window, overlap_frames):
    return _trim_source_device_stage(ctx, ctx.buffers.d_source_energy, stage_start_frame, stage_end_frame, next_window, overlap_frames, temp_ptr=ctx.buffers.d_in)


def _trim_source_input_device_stage(ctx, stage_start_frame, stage_end_frame, next_window, overlap_frames):
    return _trim_source_device_stage(ctx, ctx.buffers.d_in, stage_start_frame, stage_end_frame, next_window, overlap_frames)


def _trim_source_device_stage(ctx, device_ptr, stage_start_frame, stage_end_frame, next_window, overlap_frames, *, temp_ptr=None):
    cfg = ctx.cfg
    keep_start_frame = max(0, (next_window * cfg.frames_per_window) - overlap_frames)
    drop_frames = keep_start_frame - stage_start_frame
    if drop_frames > 0:
        keep_frames = max(0, stage_end_frame - keep_start_frame)
        if keep_frames > 0:
            frame_bytes = cfg.frame_bytes
            src_offset = drop_frames * frame_bytes
            copy_bytes = keep_frames * frame_bytes
            src_ptr = ctypes.c_void_p(device_ptr.value + src_offset)
            if temp_ptr is not None and temp_ptr.value and temp_ptr.value != device_ptr.value:
                chk(ctx.cuda.cuMemcpyDtoD_v2(temp_ptr, src_ptr, copy_bytes), 'cuMemcpyDtoD(source device overlap temp)')
                chk(ctx.cuda.cuMemcpyDtoD_v2(device_ptr, temp_ptr, copy_bytes), 'cuMemcpyDtoD(source device overlap restore)')
            else:
                chk(ctx.cuda.cuMemcpyDtoD_v2(device_ptr, src_ptr, copy_bytes), 'cuMemcpyDtoD(source device overlap)')
        stage_start_frame = keep_start_frame
    return stage_start_frame


def _trim_source_exact_stage(stage, stage_start_frame, next_window, overlap_frames, frame_bytes, frames_per_window):
    keep_start_frame = max(0, (next_window * frames_per_window) - overlap_frames)
    drop_frames = keep_start_frame - stage_start_frame
    if drop_frames > 0:
        drop_bytes = drop_frames * frame_bytes
        del stage[:drop_bytes]
        stage_start_frame = keep_start_frame
    return stage_start_frame


def _trim_source_exact_stage_fixed(stage, active_bytes, stage_start_frame, next_window, overlap_frames, frame_bytes, frames_per_window):
    keep_start_frame = max(0, (next_window * frames_per_window) - overlap_frames)
    drop_frames = keep_start_frame - stage_start_frame
    if drop_frames > 0:
        drop_bytes = min(active_bytes, drop_frames * frame_bytes)
        keep_bytes = max(0, active_bytes - drop_bytes)
        if keep_bytes > 0:
            stage[:keep_bytes] = stage[drop_bytes:drop_bytes + keep_bytes]
        active_bytes = keep_bytes
        stage_start_frame = keep_start_frame
    return stage_start_frame, active_bytes


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
