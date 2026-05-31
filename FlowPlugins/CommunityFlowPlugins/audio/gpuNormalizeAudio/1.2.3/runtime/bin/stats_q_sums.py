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
from runtime_env import env_flag
from runtime_profile import format_profile_stage
from stats_source_stage import _apply_streaming_size_update
from stream_io import FrameChunkReader


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
