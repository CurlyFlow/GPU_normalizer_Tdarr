from __future__ import annotations

import ctypes
from dataclasses import dataclass
import time

from async_apply import setup_async_apply
from cuda_driver import chk, cuda_event_create
import kernel_args
from runtime_profile import SegmentedSafeFeedbackProfile
from sync_apply import run_sync_apply


@dataclass
class ApplyPassResult:
    apply_wall_time: float = 0.0
    apply_h2d_time: float = 0.0
    apply_kernel_time: float = 0.0
    apply_d2h_time: float = 0.0
    apply_write_time: float = 0.0
    apply_async_write: int = 0
    apply_async_write_worker_time: float = 0.0
    apply_async_write_close_wait_time: float = 0.0
    apply_async_write_peak_queue: int = 0
    apply_setup_wall_time: float = 0.0
    apply_path: str = 'sync_pageable'
    apply_pinned: int = 0
    apply_stream_count: int = 0
    apply_async_fallback: str = 'none'
    exact_risk_gate_safe_chunks: int = 0
    exact_risk_gate_total_chunks: int = 0
    exact_sparse_chunk_splits: int = 0
    exact_safe_kernel_time: float = 0.0
    exact_unsafe_kernel_time: float = 0.0
    exact_prefill_kernel_time: float = 0.0
    exact_safe_apply_kernel_time: float = 0.0
    exact_unsafe_apply_kernel_time: float = 0.0
    exact_safe_chunks: int = 0
    exact_unsafe_chunks: int = 0
    exact_skip_safe_fill_chunks: int = 0
    segmented_safe_feedback_profile: SegmentedSafeFeedbackProfile | None = None
    exact_counts_host: object | None = None
    first_pass_output_metric_kernel_time: float = 0.0
    total_h2d_time: float = 0.0
    total_d2h_time: float = 0.0

    def __post_init__(self):
        if self.segmented_safe_feedback_profile is None:
            self.segmented_safe_feedback_profile = SegmentedSafeFeedbackProfile()


@dataclass
class ApplyPassContext:
    cuda: object
    args: object
    cfg: object
    buffers: object
    kernels: object
    bindings: object
    host_io: object
    a_coeffs: object
    prelimiter_unsafe_flags: list[int] | None
    emit_progress: object


def _run_async_apply(ctx, result, async_apply):
    cuda = ctx.cuda
    args = ctx.args
    cfg = ctx.cfg
    buffers = ctx.buffers
    bindings = ctx.bindings
    apply_fn = ctx.kernels.apply_fn

    apply_inputs = [buffers.d_in, buffers.d_apply_in_b]
    apply_outputs = [buffers.d_out, buffers.d_apply_out_b]
    apply_in_views = [async_apply.pinned_views[0], async_apply.pinned_views[2]]
    apply_out_views = [async_apply.pinned_views[1], async_apply.pinned_views[3]]
    apply_in_ptrs = [async_apply.pinned_ptrs[0].value, async_apply.pinned_ptrs[2].value]
    apply_out_ptrs = [async_apply.pinned_ptrs[1].value, async_apply.pinned_ptrs[3].value]
    pending = []
    launched_bytes = 0
    completed_bytes = 0
    frame_offset = 0
    apply_t0 = time.perf_counter()
    with open(args.input_f32, 'rb') as fi, open(args.output_f32, 'wb') as fo:
        while launched_bytes < cfg.nbytes:
            if len(pending) >= 2:
                completed_bytes = _finish_async_record(ctx, result, async_apply, pending.pop(0), fo, completed_bytes)
            used_slots = {record['slot'] for record in pending}
            slot = 0 if 0 not in used_slots else 1
            this_bytes = min(cfg.chunk_bytes, cfg.nbytes - launched_bytes)
            if this_bytes % cfg.frame_bytes:
                raise RuntimeError('chunk is not frame-aligned')
            got = fi.readinto(apply_in_views[slot][:this_bytes])
            if got != this_bytes:
                raise RuntimeError('short input read during apply')
            this_samples = this_bytes // cfg.input_sample_bytes
            this_frames = this_bytes // cfg.frame_bytes
            n_arg = ctypes.c_uint32(this_samples)
            offset_arg = ctypes.c_uint32(frame_offset)
            slot_in_arg = ctypes.c_uint64(apply_inputs[slot].value)
            slot_out_arg = ctypes.c_uint64(apply_outputs[slot].value)
            apply_args = kernel_args.build_apply_args(slot_in_arg, slot_out_arg, bindings.gains_arg, n_arg, bindings.channels_arg, bindings.frame_window_arg, bindings.windows_arg, offset_arg, bindings.ceiling_arg)
            stream = async_apply.streams[slot]
            events = []

            h2d_start = cuda_event_create(cuda, f'apply h2d start {slot}')
            h2d_end = cuda_event_create(cuda, f'apply h2d end {slot}')
            chk(cuda.cuEventRecord(h2d_start, stream), f'cuEventRecord(apply h2d start {slot})')
            chk(cuda.cuMemcpyHtoDAsync_v2(apply_inputs[slot], ctypes.c_void_p(apply_in_ptrs[slot]), this_bytes, stream), 'cuMemcpyHtoDAsync(apply input)')
            chk(cuda.cuEventRecord(h2d_end, stream), f'cuEventRecord(apply h2d end {slot})')
            events.append(('h2d', h2d_start, h2d_end))

            grid_samples = min(65535, max(1, (this_samples + 255) // 256))
            kernel_start = cuda_event_create(cuda, f'apply kernel start {slot}')
            kernel_end = cuda_event_create(cuda, f'apply kernel end {slot}')
            chk(cuda.cuEventRecord(kernel_start, stream), f'cuEventRecord(apply kernel start {slot})')
            chk(cuda.cuLaunchKernel(apply_fn, grid_samples, 1, 1, 256, 1, 1, 0, stream, apply_args, None), 'cuLaunchKernel(apply async)')
            chk(cuda.cuEventRecord(kernel_end, stream), f'cuEventRecord(apply kernel end {slot})')
            events.append(('kernel', kernel_start, kernel_end))

            d2h_start = cuda_event_create(cuda, f'apply d2h start {slot}')
            d2h_end = cuda_event_create(cuda, f'apply d2h end {slot}')
            chk(cuda.cuEventRecord(d2h_start, stream), f'cuEventRecord(apply d2h start {slot})')
            chk(cuda.cuMemcpyDtoHAsync_v2(ctypes.c_void_p(apply_out_ptrs[slot]), apply_outputs[slot], this_bytes, stream), 'cuMemcpyDtoHAsync(output)')
            chk(cuda.cuEventRecord(d2h_end, stream), f'cuEventRecord(apply d2h end {slot})')
            events.append(('d2h', d2h_start, d2h_end))

            pending.append({
                'slot': slot,
                'stream': stream,
                'bytes': this_bytes,
                'out_view': apply_out_views[slot],
                'events': events,
            })
            launched_bytes += this_bytes
            frame_offset += this_frames
        while pending:
            completed_bytes = _finish_async_record(ctx, result, async_apply, pending.pop(0), fo, completed_bytes)
    result.apply_wall_time += time.perf_counter() - apply_t0


def _finish_async_record(ctx, result, async_apply, record, fo, completed_bytes):
    h2d_dt, kernel_dt, d2h_dt = async_apply.finish_record(ctx.cuda, record, fo)
    result.apply_h2d_time += h2d_dt
    result.apply_kernel_time += kernel_dt
    result.apply_d2h_time += d2h_dt
    result.total_h2d_time += h2d_dt
    result.total_d2h_time += d2h_dt
    completed_bytes += record['bytes']
    ctx.emit_progress('apply', 0.75 + 0.25 * (completed_bytes / float(ctx.cfg.nbytes)))
    return completed_bytes


def run_apply_passes(cuda, args, buffers, *, cfg, kernels, bindings, host_io, a_coeffs, prelimiter_unsafe_flags, emit_progress):
    ctx = ApplyPassContext(
        cuda=cuda,
        args=args,
        cfg=cfg,
        buffers=buffers,
        kernels=kernels,
        bindings=bindings,
        host_io=host_io,
        a_coeffs=a_coeffs,
        prelimiter_unsafe_flags=prelimiter_unsafe_flags,
        emit_progress=emit_progress,
    )
    result = ApplyPassResult()
    setup_t0 = time.perf_counter()
    async_apply = setup_async_apply(cuda, args, buffers, chunk_bytes=cfg.chunk_bytes, output_chunk_bytes=cfg.output_chunk_bytes)
    result.apply_path = async_apply.path
    result.apply_pinned = async_apply.pinned
    result.apply_stream_count = async_apply.stream_count
    result.apply_async_fallback = async_apply.fallback
    if getattr(host_io, 'pinned', 0) and not async_apply.ready:
        result.apply_path = 'sync_pinned'
        result.apply_pinned = 1
    result.apply_setup_wall_time += time.perf_counter() - setup_t0

    try:
        if async_apply.ready:
            _run_async_apply(ctx, result, async_apply)
        else:
            run_sync_apply(ctx, result)
    finally:
        async_apply.cleanup(cuda)

    return result
