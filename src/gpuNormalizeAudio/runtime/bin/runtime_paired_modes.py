from __future__ import annotations

import ctypes
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

from apply_passes import run_paired_apply_passes
from cuda_buffers import allocate_runtime_buffers, free_runtime_buffers
from cuda_driver import chk
from cuda_kernel_manifest import load_cuda_kernel_set
from device_setup import build_kernel_arg_bindings, create_host_io_buffers, free_host_io_buffers, initialize_runtime_buffers
from gain_metrics import run_gain_metrics
from loudnorm_math import ebur128_filter_coeffs
from paired_stats_combined import run_paired_stats_combined_pass
from paired_stats_single import run_paired_stats_pass
from paired_stats_state import build_stats_context
from paired_encode_process import PairedEncodeProcess
from runtime_config import apply_stats_result_to_config, derive_runtime_config
from runtime_mode_state import idle_apply_stage
from runtime_secondary_args import build_paired_apply_args, build_paired_stats_args
from stats_cache import dump_stats_cache, load_stats_cache


def run_paired_stats_mode(ctx, emit_progress):
    cuda = ctx.cuda
    args = ctx.args
    cfg = ctx.cfg
    paired_host_io = None
    paired_args = build_paired_stats_args(args)
    paired_cfg = derive_runtime_config(paired_args)
    paired_kernels = load_cuda_kernel_set(cuda, ctx.cuda_session.module, paired_args, paired_cfg, chk)
    paired_buffers, paired_state_bytes = allocate_runtime_buffers(cuda, paired_args, paired_cfg)
    try:
        initialize_runtime_buffers(
            cuda,
            paired_args,
            paired_buffers,
            cfg=paired_cfg,
            state_bytes=paired_state_bytes,
            b_coeffs=ctx.b_coeffs,
            a_coeffs=ctx.a_coeffs,
        )
        paired_bindings = build_kernel_arg_bindings(paired_args, paired_buffers, paired_cfg)
        paired_host_io = create_host_io_buffers(cuda, paired_cfg)
        primary_ctx = build_stats_context(
            cuda,
            args,
            cfg,
            ctx.buffers,
            ctx.kernels,
            ctx.bindings,
            ctx.state_bytes,
            ctx.host_io,
            ctx.a_coeffs,
            emit_progress,
        )
        paired_ctx = build_stats_context(
            cuda,
            paired_args,
            paired_cfg,
            paired_buffers,
            paired_kernels,
            paired_bindings,
            paired_state_bytes,
            paired_host_io,
            ctx.a_coeffs,
            emit_progress,
        )
        if args.paired_stats_combined_decode_command_json:
            paired_results = run_paired_stats_combined_pass(
                primary_ctx,
                paired_ctx,
                cfg.input_shape.paired_stats_combined_decode_command,
                args.paired_stats_combined_channels,
            )
        else:
            paired_results = run_paired_stats_pass(primary_ctx, paired_ctx)
        stats_result = paired_results.primary
        paired_stats_result = paired_results.partner
        ctx.cfg = apply_stats_result_to_config(ctx.cfg, stats_result)
        cfg = ctx.cfg
        paired_cfg = apply_stats_result_to_config(paired_cfg, paired_stats_result)
        ctx.bindings.update_frame_totals(total_frames=cfg.input_shape.total_frames, windows=cfg.input_shape.windows)
        paired_bindings.update_frame_totals(total_frames=paired_cfg.input_shape.total_frames, windows=paired_cfg.input_shape.windows)
        dump_stats_cache(args.stats_cache_output, cuda, args, cfg, ctx.buffers, stats_result)
        dump_stats_cache(paired_args.stats_cache_output, cuda, paired_args, paired_cfg, paired_buffers, paired_stats_result)
        idle_result = idle_apply_stage()
        idle_result.stats_result = stats_result
        emit_progress('stats_sums', 1.0)
        return idle_result
    finally:
        if paired_host_io is not None:
            free_host_io_buffers(cuda, paired_host_io)
        free_runtime_buffers(cuda, paired_buffers)


def run_paired_apply_mode(ctx, gain_metrics, emit_progress):
    args = ctx.args
    cuda = ctx.cuda
    paired_apply_host_io = None

    if not args.paired_apply_encode_command_json or not args.paired_apply_stats_cache_input or args.paired_apply_channels <= 0:
        raise SystemExit('--paired-apply-decode-command-json requires paired encode command, stats cache input, and channels')

    paired_apply_args = build_paired_apply_args(args)
    paired_apply_cfg = derive_runtime_config(paired_apply_args)
    paired_b_coeffs, paired_a_coeffs = ebur128_filter_coeffs(paired_apply_args.rate)
    paired_apply_kernels = load_cuda_kernel_set(cuda, ctx.cuda_session.module, paired_apply_args, paired_apply_cfg, chk)
    paired_apply_buffers, paired_apply_state_bytes = allocate_runtime_buffers(cuda, paired_apply_args, paired_apply_cfg)
    try:
        initialize_runtime_buffers(
            cuda,
            paired_apply_args,
            paired_apply_buffers,
            cfg=paired_apply_cfg,
            state_bytes=paired_apply_state_bytes,
            b_coeffs=paired_b_coeffs,
            a_coeffs=paired_a_coeffs,
        )
        paired_apply_bindings = build_kernel_arg_bindings(paired_apply_args, paired_apply_buffers, paired_apply_cfg)
        paired_apply_host_io = create_host_io_buffers(cuda, paired_apply_cfg)
        paired_apply_stats_result = load_stats_cache(
            paired_apply_args.stats_cache_input,
            cuda,
            paired_apply_args,
            paired_apply_cfg,
            paired_apply_buffers,
        )
        paired_apply_cfg = apply_stats_result_to_config(paired_apply_cfg, paired_apply_stats_result)
        paired_apply_bindings.update_frame_totals(total_frames=paired_apply_cfg.input_shape.total_frames, windows=paired_apply_cfg.input_shape.windows)
        if gain_metrics is None:
            streams = [ctypes.c_void_p(), ctypes.c_void_p()]

            def run_on_stream(run_args, run_cfg, run_buffers, run_kernels, run_bindings, stream):
                chk(cuda.cuCtxPushCurrent_v2(ctx.cuda_session.ctx), 'cuCtxPushCurrent(paired gain plan)')
                try:
                    return run_gain_metrics(
                        cuda,
                        run_args,
                        cfg=run_cfg,
                        buffers=run_buffers,
                        kernels=run_kernels,
                        bindings=run_bindings,
                        emit_progress=lambda *_: None,
                        stream=stream,
                    )
                finally:
                    popped = ctypes.c_void_p()
                    chk(cuda.cuCtxPopCurrent_v2(ctypes.byref(popped)), 'cuCtxPopCurrent(paired gain plan)')

            try:
                for stream in streams:
                    chk(cuda.cuStreamCreate(ctypes.byref(stream), 0), 'cuStreamCreate(paired gain plan)')
                with ThreadPoolExecutor(max_workers=2) as executor:
                    primary_future = executor.submit(
                        run_on_stream,
                        args,
                        ctx.cfg,
                        ctx.buffers,
                        ctx.kernels,
                        ctx.bindings,
                        streams[0],
                    )
                    partner_future = executor.submit(
                        run_on_stream,
                        paired_apply_args,
                        paired_apply_cfg,
                        paired_apply_buffers,
                        paired_apply_kernels,
                        paired_apply_bindings,
                        streams[1],
                    )
                    gain_metrics = primary_future.result()
                    paired_gain_metrics = partner_future.result()
                emit_progress('gain_plan', 0.75)
            finally:
                for stream in streams:
                    if stream.value:
                        cuda.cuStreamDestroy_v2(stream)
        else:
            paired_gain_metrics = run_gain_metrics(
                cuda,
                paired_apply_args,
                cfg=paired_apply_cfg,
                buffers=paired_apply_buffers,
                kernels=paired_apply_kernels,
                bindings=paired_apply_bindings,
                emit_progress=emit_progress,
            )
        paired_encode = PairedEncodeProcess.start(ctx.cfg.input_shape.encode_command, paired_apply_cfg.input_shape.encode_command)
        if paired_encode is not None:
            primary_command, partner_command = paired_encode.encode_commands()
            ctx.cfg.input_shape = replace(ctx.cfg.input_shape, encode_command=primary_command)
            paired_apply_cfg.input_shape = replace(paired_apply_cfg.input_shape, encode_command=partner_command)
        try:
            apply_result, _paired_apply_result = run_paired_apply_passes(
                cuda,
                args,
                ctx.buffers,
                cuda_session=ctx.cuda_session,
                primary_cfg=ctx.cfg,
                primary_kernels=ctx.kernels,
                primary_bindings=ctx.bindings,
                primary_host_io=ctx.host_io,
                primary_a_coeffs=ctx.a_coeffs,
                primary_prelimiter_unsafe_flags=gain_metrics.prelimiter_unsafe_flags,
                partner_args=paired_apply_args,
                partner_buffers=paired_apply_buffers,
                partner_cfg=paired_apply_cfg,
                partner_kernels=paired_apply_kernels,
                partner_bindings=paired_apply_bindings,
                partner_host_io=paired_apply_host_io,
                partner_a_coeffs=paired_a_coeffs,
                partner_prelimiter_unsafe_flags=paired_gain_metrics.prelimiter_unsafe_flags,
                emit_progress=emit_progress,
            )
            if paired_encode is not None:
                paired_encode.wait()
        except BaseException:
            if paired_encode is not None:
                paired_encode.abort()
            raise
        return (gain_metrics, apply_result) if ctx.cfg.exact.paired_gain_plan_concurrent else apply_result
    finally:
        if paired_apply_host_io is not None:
            free_host_io_buffers(cuda, paired_apply_host_io)
        free_runtime_buffers(cuda, paired_apply_buffers)
