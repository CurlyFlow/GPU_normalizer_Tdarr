import time

from apply_async_pass import run_async_apply
from apply_pass_state import ApplyPassContext, ApplyPassResult
from apply_sync_pass import run_paired_sync_apply, run_sync_apply
from async_apply import setup_async_apply
from short_source import is_short_first_frame


def run_apply_passes(cuda, args, buffers, *, cuda_session=None, cfg, kernels, bindings, host_io, a_coeffs, prelimiter_unsafe_flags, emit_progress):
    ctx = ApplyPassContext(
        cuda=cuda,
        cuda_session=cuda_session,
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
    async_apply = setup_async_apply(cuda, args, buffers, chunk_bytes=cfg.sizing.chunk_bytes, output_chunk_bytes=cfg.sizing.output_chunk_bytes)
    result.apply_path = async_apply.path
    result.apply_pinned = async_apply.pinned
    result.apply_stream_count = async_apply.stream_count
    result.apply_async_fallback = async_apply.fallback
    if getattr(host_io, 'pinned', 0) and not async_apply.ready:
        result.apply_path = 'sync_pinned'
        result.apply_pinned = 1
    result.apply_setup_wall_time += time.perf_counter() - setup_t0

    try:
        if async_apply.ready and not is_short_first_frame(args, cfg):
            run_async_apply(ctx, result, async_apply)
        else:
            run_sync_apply(ctx, result)
    finally:
        async_apply.cleanup(cuda)

    return result


def run_paired_apply_passes(
    cuda,
    primary_args,
    primary_buffers,
    *,
    cuda_session=None,
    primary_cfg,
    primary_kernels,
    primary_bindings,
    primary_host_io,
    primary_a_coeffs,
    primary_prelimiter_unsafe_flags,
    partner_args,
    partner_buffers,
    partner_cfg,
    partner_kernels,
    partner_bindings,
    partner_host_io,
    partner_a_coeffs,
    partner_prelimiter_unsafe_flags,
    emit_progress,
):
    primary_ctx = ApplyPassContext(
        cuda=cuda,
        cuda_session=cuda_session,
        args=primary_args,
        cfg=primary_cfg,
        buffers=primary_buffers,
        kernels=primary_kernels,
        bindings=primary_bindings,
        host_io=primary_host_io,
        a_coeffs=primary_a_coeffs,
        prelimiter_unsafe_flags=primary_prelimiter_unsafe_flags,
        emit_progress=emit_progress,
    )
    partner_ctx = ApplyPassContext(
        cuda=cuda,
        cuda_session=cuda_session,
        args=partner_args,
        cfg=partner_cfg,
        buffers=partner_buffers,
        kernels=partner_kernels,
        bindings=partner_bindings,
        host_io=partner_host_io,
        a_coeffs=partner_a_coeffs,
        prelimiter_unsafe_flags=partner_prelimiter_unsafe_flags,
        emit_progress=emit_progress,
    )
    primary_result = ApplyPassResult()
    partner_result = ApplyPassResult()
    setup_t0 = time.perf_counter()
    if getattr(primary_host_io, 'pinned', 0):
        primary_result.apply_path = 'paired_sync_pinned'
        primary_result.apply_pinned = 1
    else:
        primary_result.apply_path = 'paired_sync_pageable'
    if getattr(partner_host_io, 'pinned', 0):
        partner_result.apply_path = 'paired_sync_pinned'
        partner_result.apply_pinned = 1
    else:
        partner_result.apply_path = 'paired_sync_pageable'
    setup_dt = time.perf_counter() - setup_t0
    primary_result.apply_setup_wall_time += setup_dt
    partner_result.apply_setup_wall_time += setup_dt
    run_paired_sync_apply(primary_ctx, primary_result, partner_ctx, partner_result)
    return primary_result, partner_result
