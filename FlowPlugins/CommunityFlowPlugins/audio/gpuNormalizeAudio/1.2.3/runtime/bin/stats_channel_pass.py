from __future__ import annotations

import array
import ctypes
import math
import os
import struct
import sys
import time

from cuda_driver import chk, has_async_apply_api
from cuda_launch import launch_kernel, launch_timed_kernel
import kernel_args
from kweight_state import build_start_states
from loudnorm_math import input_loudness_range_from_window_sums, input_loudness_threshold_from_window_sums
from runtime_profile import format_profile_stage
from stats_channel_pipeline import create_source_stage_config
from stats_q_sums import combine_channel_sums
from stats_source_runner import SourcePrecomputeRunner
from stream_io import FrameChunkReader


def run_exact_sums_pass(ctx, result):
    args = ctx.args
    cfg = ctx.cfg
    host_in = ctx.host_io.host_in
    host_in_ptr = ctx.host_io.host_in_ptr
    source_precompute = SourcePrecomputeRunner(ctx, result)

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
            source_precompute.apply_streaming_size_update(chunks.done_bytes)
            ctx.emit_progress('stats_sums', 0.70)


def run_channel_stats_pass(ctx, result):
    args = ctx.args
    cfg = ctx.cfg
    host_in = ctx.host_io.host_in
    host_in_ptr = ctx.host_io.host_in_ptr
    source_precompute = SourcePrecomputeRunner(ctx, result)
    source_stage_config = create_source_stage_config(cfg, allow_fixed_buffer=True)
    use_source_device_energy = source_stage_config.use_source_device_energy
    use_source_device_input = source_stage_config.use_source_device_input
    use_source_fixed_buffer = source_stage_config.use_source_fixed_buffer
    source_stage = source_stage_config.source_stage
    source_stage_active_bytes = 0
    audit_tail = source_stage_config.audit_tail
    source_stage_start_frame = 0
    source_energy_stage_end_frame = 0
    source_input_stage_end_frame = 0
    next_source_window = 0
    source_overlap_frames = source_stage_config.source_overlap_frames
    source_energy_capacity_frames = source_stage_config.source_energy_capacity_frames
    source_input_capacity_frames = source_stage_config.source_input_capacity_frames

    peak_stream = ctypes.c_void_p()
    channel_stream = ctypes.c_void_p()
    use_combined_peaks = bool(cfg.exact_channel_stats_combined_peaks)
    cuda_has_async_api = has_async_apply_api(ctx.cuda)
    use_parallel_peaks = bool((not use_combined_peaks) and cfg.exact_stats_parallel_peaks and cuda_has_async_api)
    use_async_pipeline = bool(
        cfg.exact_stats_async_pipeline
        and cuda_has_async_api
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
                        next_source_window = source_precompute.run_stage(
                            None,
                            source_stage_start_frame,
                            next_source_window,
                            ready_windows,
                            device_energy_end_frame=source_energy_stage_end_frame,
                        )
                        ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
                        source_stage_start_frame = source_precompute.trim_energy_stage(
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
                        next_source_window = source_precompute.run_stage(
                            None,
                            source_stage_start_frame,
                            next_source_window,
                            ready_windows,
                            device_input_end_frame=source_input_stage_end_frame,
                        )
                        ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
                        source_stage_start_frame = source_precompute.trim_input_device_stage(
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
                        next_source_window = source_precompute.run_stage(
                            source_stage,
                            source_stage_start_frame,
                            next_source_window,
                            ready_windows,
                            stage_active_bytes=source_stage_active_bytes if use_source_fixed_buffer else None,
                        )
                        ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.nbytes)))
                        if use_source_fixed_buffer:
                            source_stage_start_frame, source_stage_active_bytes = source_precompute.trim_exact_stage_fixed(
                                source_stage,
                                source_stage_active_bytes,
                                source_stage_start_frame,
                                next_source_window,
                                source_overlap_frames,
                                cfg.frame_bytes,
                                cfg.frames_per_window,
                            )
                        else:
                            source_stage_start_frame = source_precompute.trim_exact_stage(
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
                source_precompute.apply_streaming_size_update(chunks.done_bytes)
            if use_source_device_energy:
                if result.windows > next_source_window:
                    sync_async_stats('stats async final source device precompute')
                    next_source_window = source_precompute.run_stage(
                        None,
                        source_stage_start_frame,
                        next_source_window,
                        result.windows,
                        device_energy_end_frame=source_energy_stage_end_frame,
                    )
                if next_source_window != result.windows:
                    raise RuntimeError(f'fused source device precompute incomplete: windows={next_source_window} expected={result.windows}')
                source_precompute.finish_source_sum_audit()
            elif use_source_device_input:
                if result.windows > next_source_window:
                    next_source_window = source_precompute.run_stage(
                        None,
                        source_stage_start_frame,
                        next_source_window,
                        result.windows,
                        device_input_end_frame=source_input_stage_end_frame,
                    )
                if next_source_window != result.windows:
                    raise RuntimeError(f'fused source input precompute incomplete: windows={next_source_window} expected={result.windows}')
                source_precompute.finish_source_sum_audit()
            elif source_stage is not None:
                if result.windows > next_source_window:
                    sync_async_stats('stats async final source precompute')
                    next_source_window = source_precompute.run_stage(
                        source_stage,
                        source_stage_start_frame,
                        next_source_window,
                        result.windows,
                        stage_active_bytes=source_stage_active_bytes if use_source_fixed_buffer else None,
                    )
                if next_source_window != result.windows:
                    raise RuntimeError(f'fused source exact precompute incomplete: windows={next_source_window} expected={result.windows}')
                source_precompute.finish_source_sum_audit()
            combine_channel_sums(ctx, result, source_arg=ctx.bindings.start_states_arg, label='combine-channel-sums')
            if audit_tail is not None:
                source_precompute.audit_ffmpeg_input_metrics(audit_tail)
            ctx.emit_progress('stats_sums', 0.70)
    finally:
        if channel_stream.value:
            ctx.cuda.cuStreamDestroy_v2(channel_stream)
        if peak_stream.value:
            ctx.cuda.cuStreamDestroy_v2(peak_stream)
        for stream in stats_streams:
            if stream.value:
                ctx.cuda.cuStreamDestroy_v2(stream)
