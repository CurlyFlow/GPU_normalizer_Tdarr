from __future__ import annotations

from apply_passes import run_apply_passes
from gain_metrics import run_gain_metrics
from runtime_config import apply_stats_result_to_config, derive_runtime_config
from runtime_mode_state import RuntimeApplyResult, RuntimeModeContext, RuntimeStageResult, idle_apply_stage
from runtime_paired_modes import run_paired_apply_mode, run_paired_stats_mode
from stats_cache import dump_stats_cache, load_stats_cache
from stats_passes import run_stats_passes


def run_stats_stage(ctx, emit_progress):
    cuda = ctx.cuda
    args = ctx.args
    cfg = ctx.cfg

    if args.paired_stats_decode_command_json:
        return run_paired_stats_mode(ctx, emit_progress)
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
    ctx.bindings.update_frame_totals(total_frames=cfg.input_shape.total_frames, windows=cfg.input_shape.windows)

    if args.stats_cache_output:
        dump_stats_cache(args.stats_cache_output, cuda, args, cfg, ctx.buffers, stats_result)

    if args.stats_cache_only:
        idle_result = idle_apply_stage()
        idle_result.stats_result = stats_result
        emit_progress('stats_sums', 1.0)
        return idle_result

    return RuntimeStageResult(stats_result=stats_result)


def run_gain_and_apply_stage(ctx, emit_progress):
    if ctx.args.paired_apply_decode_command_json and ctx.cfg.exact.paired_gain_plan_concurrent:
        gain_metrics, apply_result = run_paired_apply_mode(ctx, None, emit_progress)
        return RuntimeApplyResult(gain_metrics=gain_metrics, apply_result=apply_result)

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
        apply_result = run_paired_apply_mode(ctx, gain_metrics, emit_progress)
    else:
        apply_result = run_apply_passes(
            ctx.cuda,
            ctx.args,
            ctx.buffers,
            cuda_session=ctx.cuda_session,
            cfg=ctx.cfg,
            kernels=ctx.kernels,
            bindings=ctx.bindings,
            host_io=ctx.host_io,
            a_coeffs=ctx.a_coeffs,
            prelimiter_unsafe_flags=gain_metrics.prelimiter_unsafe_flags,
            emit_progress=emit_progress,
        )
    return RuntimeApplyResult(gain_metrics=gain_metrics, apply_result=apply_result)
