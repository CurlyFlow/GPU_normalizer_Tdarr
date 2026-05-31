from __future__ import annotations

import ctypes
import time

from cuda_driver import chk
from cuda_launch import launch_kernel, launch_timed_kernel
import kernel_args
from stats_source_audit import _audit_source_sums_stage, _finish_source_sum_audit
from stats_source_stage import (
    _source_block_output_arg,
    _source_exact_output_arg,
)
from stream_io import FrameChunkReader
from runtime_env import env_flag



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
