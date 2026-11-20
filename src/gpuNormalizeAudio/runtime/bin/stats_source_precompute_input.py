from __future__ import annotations

import ctypes
import time
from dataclasses import dataclass

from cuda_driver import chk


@dataclass(frozen=True)
class SourcePrecomputeStageInput:
    using_device_energy: bool
    using_device_input: bool
    copy_frames: int
    stage_bytes: int
    input_base_arg: object
    input_frames_arg: object
    target_start_arg: object
    target_windows_arg: object
    grid_windows: int


def plan_source_precompute_stage_input(ctx, result, stage, stage_start_frame, next_window, ready_windows, *, device_energy_end_frame=None, device_input_end_frame=None, stage_active_bytes=None):
    cfg = ctx.cfg
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
        stage_frames = (len(stage) if stage_active_bytes is None else stage_active_bytes) // cfg.sizing.frame_bytes
    needed_end_frame = result.total_frames if ready_windows >= result.windows else ready_windows * cfg.input_shape.frames_per_window
    copy_frames = min(stage_frames, max(0, needed_end_frame - stage_start_frame))
    stage_bytes = copy_frames * cfg.sizing.frame_bytes
    if not (using_device_energy or using_device_input) and stage_bytes > len(ctx.host_io.host_in):
        raise RuntimeError(f'source exact precompute staging exceeded: need={stage_bytes} capacity={len(ctx.host_io.host_in)}')
    return SourcePrecomputeStageInput(
        using_device_energy=using_device_energy,
        using_device_input=using_device_input,
        copy_frames=copy_frames,
        stage_bytes=stage_bytes,
        input_base_arg=ctypes.c_uint32(stage_start_frame),
        input_frames_arg=ctypes.c_uint32(copy_frames),
        target_start_arg=ctypes.c_uint32(next_window),
        target_windows_arg=ctypes.c_uint32(ready_windows - next_window),
        grid_windows=min(65535, max(1, ((ready_windows - next_window) + 127) // 128)),
    )


def copy_source_precompute_stage_input(ctx, stage, stage_input):
    if stage_input.using_device_energy or stage_input.using_device_input:
        return 0.0
    copy_t0 = time.perf_counter()
    if getattr(ctx.cfg.source, 'source_stage_direct_h2d', False) and stage_input.stage_bytes > 0:
        stage_ptr = ctypes.addressof(ctypes.c_char.from_buffer(stage))
        chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_in, ctypes.c_void_p(stage_ptr), stage_input.stage_bytes), 'cuMemcpyHtoD(source exact precompute direct input)')
    else:
        memoryview(ctx.host_io.host_in)[:stage_input.stage_bytes] = memoryview(stage)[:stage_input.stage_bytes]
        chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_in, ctypes.c_void_p(ctx.host_io.host_in_ptr), stage_input.stage_bytes), 'cuMemcpyHtoD(source exact precompute input)')
    return time.perf_counter() - copy_t0
