from __future__ import annotations

import ctypes
from dataclasses import dataclass

import kernel_args


@dataclass
class ChannelChunkPlan:
    input_arg: object
    input_ptr: object
    frames_arg: object
    frame_offset_arg: object
    channel_args: object
    checkpoint_args: object
    replay_args: object
    replay_grid: int
    channel_kernel_fn: object
    peak_args: object
    peak_grid: int
    chunk_input_ptr: int
    chunk_view: object


def build_channel_chunk_plan(ctx, mode, source_stage, chunk, async_slot):
    args = ctx.args
    cfg = ctx.cfg
    input_arg = ctx.bindings.in_arg
    input_ptr = ctx.buffers.d_in
    if mode.use_async_pipeline and async_slot == 1:
        input_arg = ctypes.c_uint64(ctx.buffers.d_stats_in_b.value)
        input_ptr = ctx.buffers.d_stats_in_b
    elif mode.source_stage_config.use_source_device_input:
        input_ptr, input_arg = source_stage.device_input_for_chunk(chunk)
    this_samples = chunk.this_frames * args.channels
    frames_arg = ctypes.c_uint32(chunk.this_frames)
    frame_offset_arg = ctypes.c_uint32(chunk.frame_offset)
    channel_peaks_arg = ctx.bindings.peaks_arg if mode.use_combined_peaks else ctypes.c_uint64(0)
    if mode.source_stage_config.use_source_device_energy:
        source_energy_base_arg, source_energy_frames_arg = source_stage.source_energy_kernel_args(chunk)
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
    checkpoint_args = None
    replay_args = None
    replay_grid = 1
    if mode.use_checkpoint_replay:
        checkpoint_args, replay_args, replay_grid = _build_checkpoint_replay_args(ctx, input_arg, chunk, frames_arg, frame_offset_arg)
    channel_kernel_fn = _select_channel_kernel(ctx, mode)
    peak_args = kernel_args.build_peak_args(
        input_arg,
        ctx.bindings.peaks_arg,
        frames_arg,
        ctx.bindings.channels_arg,
        ctx.bindings.frame_window_arg,
        frame_offset_arg,
    )
    peak_grid = min(65535, max(1, (this_samples + 255) // 256))
    chunk_input_ptr = ctx.host_io.host_in_ptr
    chunk_view = None
    if getattr(chunk, 'payload_ptr', 0):
        chunk_input_ptr = chunk.payload_ptr
        chunk_view = memoryview(chunk.payload)
    return ChannelChunkPlan(
        input_arg=input_arg,
        input_ptr=input_ptr,
        frames_arg=frames_arg,
        frame_offset_arg=frame_offset_arg,
        channel_args=channel_args,
        checkpoint_args=checkpoint_args,
        replay_args=replay_args,
        replay_grid=replay_grid,
        channel_kernel_fn=channel_kernel_fn,
        peak_args=peak_args,
        peak_grid=peak_grid,
        chunk_input_ptr=chunk_input_ptr,
        chunk_view=chunk_view,
    )


def _build_checkpoint_replay_args(ctx, input_arg, chunk, frames_arg, frame_offset_arg):
    cfg = ctx.cfg
    args = ctx.args
    if not ctx.buffers.d_checkpoint_states.value:
        raise RuntimeError('checkpoint replay stats requested without checkpoint state buffer')
    if chunk.frame_offset % cfg.input_shape.frames_per_window:
        raise RuntimeError(f'checkpoint replay stats requires window-aligned chunks: frame_offset={chunk.frame_offset}')
    checkpoint_args = kernel_args.build_channel_checkpoint_args(
        input_arg,
        ctx.bindings.peaks_arg,
        ctx.bindings.q_states_arg,
        ctx.bindings.checkpoint_states_arg,
        ctx.bindings.source_start_states_arg,
        frames_arg,
        ctx.bindings.channels_arg,
        ctx.bindings.frame_window_arg,
        frame_offset_arg,
        ctx.bindings.a_arg,
    )
    window_offset_arg = ctypes.c_uint32(chunk.frame_offset // cfg.input_shape.frames_per_window)
    replay_args = kernel_args.build_sums_args(
        input_arg,
        ctx.bindings.start_states_arg,
        ctx.bindings.checkpoint_states_arg,
        frames_arg,
        ctx.bindings.channels_arg,
        ctx.bindings.frame_window_arg,
        window_offset_arg,
        ctx.bindings.b_arg,
        ctx.bindings.a_arg,
    )
    windows_this = (chunk.this_frames + cfg.input_shape.frames_per_window - 1) // cfg.input_shape.frames_per_window
    replay_pairs = windows_this * args.channels
    return checkpoint_args, replay_args, min(65535, max(1, (replay_pairs + 255) // 256))


def _select_channel_kernel(ctx, mode):
    cfg = ctx.cfg
    if mode.source_stage_config.use_source_device_energy:
        return ctx.kernels.channel_sums_source_energy_fn
    if mode.use_checkpoint_replay:
        return ctx.kernels.prefix_channel_sums_fn
    if mode.use_channel_warp:
        return ctx.kernels.channel_sums_warp_fn
    if getattr(cfg.exact, 'exact_channel_stats_unroll4', False) and not mode.use_combined_peaks:
        return ctx.kernels.channel_sums_unroll4_fn
    if getattr(cfg.exact, 'exact_channel_stats_no_peaks', False) and not mode.use_combined_peaks:
        return ctx.kernels.channel_sums_no_peaks_fn
    return ctx.kernels.channel_sums_fn
