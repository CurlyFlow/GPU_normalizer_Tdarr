from __future__ import annotations

from dataclasses import dataclass

from apply_passes import ApplyPassResult, run_apply_passes, run_paired_apply_passes
from cuda_buffers import allocate_runtime_buffers, free_runtime_buffers
from cuda_kernels import load_kernel_set
from device_setup import build_kernel_arg_bindings, create_host_io_buffers, free_host_io_buffers, initialize_runtime_buffers
from gain_metrics import GainMetricsResult, run_gain_metrics
from loudnorm_math import ebur128_filter_coeffs
from paired_stats import build_stats_context, run_paired_stats_combined_pass, run_paired_stats_pass
from runtime_config import apply_stats_result_to_config, derive_runtime_config
from runtime_secondary_args import build_paired_apply_args, build_paired_stats_args
from stats_cache import dump_stats_cache, load_stats_cache, read_stats_cache_header
from stats_passes import run_stats_passes


@dataclass
class RuntimeModeContext:
    cuda: object
    cuda_session: object
    args: object
    cfg: object
    buffers: object
    kernels: object
    bindings: object
    state_bytes: int
    host_io: object
    b_coeffs: object
    a_coeffs: object


@dataclass
class RuntimeStageResult:
    stats_result: object
    gain_metrics: object = None
    apply_result: object = None


@dataclass
class RuntimeApplyResult:
    gain_metrics: object
    apply_result: object


def _idle_apply_stage():
    return RuntimeStageResult(
        stats_result=None,
        gain_metrics=GainMetricsResult(input_i=float('nan'), gain_min_amp=1.0, gain_max_amp=1.0),
        apply_result=ApplyPassResult(),
    )


def _run_paired_stats_mode(ctx, emit_progress):
    cuda = ctx.cuda
    args = ctx.args
    cfg = ctx.cfg
    paired_host_io = None
    paired_args = build_paired_stats_args(args)
    paired_cfg = derive_runtime_config(paired_args)
    paired_kernels = load_kernel_set(cuda, ctx.cuda_session.module, paired_args, paired_cfg)
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
                cfg.paired_stats_combined_decode_command,
                args.paired_stats_combined_channels,
            )
        else:
            paired_results = run_paired_stats_pass(primary_ctx, paired_ctx)
        stats_result = paired_results.primary
        paired_stats_result = paired_results.partner
        ctx.cfg = apply_stats_result_to_config(ctx.cfg, stats_result)
        cfg = ctx.cfg
        paired_cfg = apply_stats_result_to_config(paired_cfg, paired_stats_result)
        ctx.bindings.update_frame_totals(total_frames=cfg.total_frames, windows=cfg.windows)
        paired_bindings.update_frame_totals(total_frames=paired_cfg.total_frames, windows=paired_cfg.windows)
        dump_stats_cache(args.stats_cache_output, cuda, args, cfg, ctx.buffers, stats_result)
        dump_stats_cache(paired_args.stats_cache_output, cuda, paired_args, paired_cfg, paired_buffers, paired_stats_result)
        idle_result = _idle_apply_stage()
        idle_result.stats_result = stats_result
        emit_progress('stats_sums', 1.0)
        return idle_result
    finally:
        if paired_host_io is not None:
            free_host_io_buffers(cuda, paired_host_io)
        free_runtime_buffers(cuda, paired_buffers)


def run_stats_stage(ctx, emit_progress):
    cuda = ctx.cuda
    args = ctx.args
    cfg = ctx.cfg

    if args.paired_stats_decode_command_json:
        return _run_paired_stats_mode(ctx, emit_progress)
    if args.stats_cache_input:
        stats_result = load_stats_cache(args.stats_cache_input, cuda, args, cfg, ctx.buffers)
    else:
        stats_result = run_stats_passes(
            cuda,
            args,
            cfg=cfg,
            buffers=ctx.buffers,
            kernels=ctx.kernels,
            bindings=ctx.bindings,
            state_bytes=ctx.state_bytes,
            host_io=ctx.host_io,
            a_coeffs=ctx.a_coeffs,
            emit_progress=emit_progress,
        )
    ctx.cfg = apply_stats_result_to_config(cfg, stats_result)
    cfg = ctx.cfg
    ctx.bindings.update_frame_totals(total_frames=cfg.total_frames, windows=cfg.windows)

    if args.stats_cache_output:
        dump_stats_cache(args.stats_cache_output, cuda, args, cfg, ctx.buffers, stats_result)

    if args.stats_cache_only:
        idle_result = _idle_apply_stage()
        idle_result.stats_result = stats_result
        emit_progress('stats_sums', 1.0)
        return idle_result

    return RuntimeStageResult(stats_result=stats_result)


def _run_paired_apply_mode(ctx, gain_metrics, emit_progress):
    args = ctx.args
    cuda = ctx.cuda
    paired_apply_host_io = None

    if not args.paired_apply_encode_command_json or not args.paired_apply_stats_cache_input or args.paired_apply_channels <= 0:
        raise SystemExit('--paired-apply-decode-command-json requires paired encode command, stats cache input, and channels')

    paired_apply_args = build_paired_apply_args(args)
    paired_apply_cfg = derive_runtime_config(paired_apply_args)
    if paired_apply_cfg.stats_cache_header_sizing:
        paired_apply_cfg = apply_stats_result_to_config(
            paired_apply_cfg,
            read_stats_cache_header(paired_apply_args.stats_cache_input, paired_apply_args, paired_apply_cfg),
        )
    paired_b_coeffs, paired_a_coeffs = ebur128_filter_coeffs(paired_apply_args.rate)
    paired_apply_kernels = load_kernel_set(cuda, ctx.cuda_session.module, paired_apply_args, paired_apply_cfg)
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
        paired_apply_bindings.update_frame_totals(total_frames=paired_apply_cfg.total_frames, windows=paired_apply_cfg.windows)
        paired_gain_metrics = run_gain_metrics(
            cuda,
            paired_apply_args,
            cfg=paired_apply_cfg,
            buffers=paired_apply_buffers,
            kernels=paired_apply_kernels,
            bindings=paired_apply_bindings,
            emit_progress=emit_progress,
        )
        apply_result, _paired_apply_result = run_paired_apply_passes(
            cuda,
            args,
            ctx.buffers,
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
        return apply_result
    finally:
        if paired_apply_host_io is not None:
            free_host_io_buffers(cuda, paired_apply_host_io)
        free_runtime_buffers(cuda, paired_apply_buffers)


def run_gain_and_apply_stage(ctx, emit_progress):
    gain_metrics = run_gain_metrics(
        ctx.cuda,
        ctx.args,
        cfg=ctx.cfg,
        buffers=ctx.buffers,
        kernels=ctx.kernels,
        bindings=ctx.bindings,
        emit_progress=emit_progress,
    )

    if ctx.args.paired_apply_decode_command_json:
        apply_result = _run_paired_apply_mode(ctx, gain_metrics, emit_progress)
    else:
        apply_result = run_apply_passes(
            ctx.cuda,
            ctx.args,
            ctx.buffers,
            cfg=ctx.cfg,
            kernels=ctx.kernels,
            bindings=ctx.bindings,
            host_io=ctx.host_io,
            a_coeffs=ctx.a_coeffs,
            prelimiter_unsafe_flags=gain_metrics.prelimiter_unsafe_flags,
            emit_progress=emit_progress,
        )
    return RuntimeApplyResult(gain_metrics=gain_metrics, apply_result=apply_result)
