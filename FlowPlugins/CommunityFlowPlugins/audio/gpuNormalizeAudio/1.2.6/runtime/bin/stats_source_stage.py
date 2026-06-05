from __future__ import annotations

import ctypes

from cuda_driver import chk


def _source_exact_output_arg(ctx):
    if ctx.cfg.source_sum_audit and ctx.cfg.source_block_sums:
        return ctx.bindings.source_exact_audit_sums_arg
    return ctx.bindings.source_exact_sums_arg


def _source_block_output_arg(ctx):
    if ctx.cfg.source_block_sums:
        return ctx.bindings.source_exact_sums_arg
    return ctx.bindings.source_exact_audit_sums_arg


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
