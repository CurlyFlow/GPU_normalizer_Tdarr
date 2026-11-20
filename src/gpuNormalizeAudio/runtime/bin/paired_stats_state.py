from __future__ import annotations

from dataclasses import dataclass

from stats_channel_pipeline import create_source_stage_config
from stats_pass_state import StatsPassContext, StatsPassResult
from stats_q_sums import combine_channel_sums
from stats_source_audit import _audit_ffmpeg_input_metrics, _finish_source_sum_audit
from stats_source_precompute import run_source_exact_precompute_pass
from stats_source_precompute_stage import _run_source_exact_precompute_stage
from stats_source_stage import _apply_streaming_size_update


@dataclass
class _PairedStatsRunner:
    label: str
    ctx: StatsPassContext
    result: StatsPassResult
    source_stage: bytearray | None
    audit_tail: bytearray | None
    source_stage_start_frame: int = 0
    source_energy_stage_end_frame: int = 0
    source_device_stage_end_frame: int = 0
    source_stage_on_device: bool = False
    next_source_window: int = 0
    chunk_index: int = 0


def _new_result(ctx):
    return StatsPassResult(
        nbytes=ctx.cfg.input_shape.nbytes,
        mib=ctx.cfg.input_shape.mib,
        total_samples=ctx.cfg.input_shape.total_samples,
        total_frames=ctx.cfg.input_shape.total_frames,
        windows=ctx.cfg.input_shape.windows,
        seconds=ctx.cfg.input_shape.seconds,
        state_bytes=ctx.state_bytes,
    )


def _new_runner(label, ctx):
    result = _new_result(ctx)
    source_stage_config = create_source_stage_config(ctx.cfg)
    runner = _PairedStatsRunner(
        label=label,
        ctx=ctx,
        result=result,
        source_stage=source_stage_config.source_stage,
        audit_tail=source_stage_config.audit_tail,
    )
    return runner


def _finish_runner(runner, chunks):
    ctx = runner.ctx
    cfg = ctx.cfg
    result = runner.result
    if cfg.root.streaming_io:
        _apply_streaming_size_update(ctx, result, chunks.done_bytes)
    if runner.source_stage_on_device:
        if result.windows > runner.next_source_window:
            runner.next_source_window = _run_source_exact_precompute_stage(
                ctx,
                result,
                None,
                runner.source_stage_start_frame,
                runner.next_source_window,
                result.windows,
                device_input_end_frame=runner.source_device_stage_end_frame,
            )
        if runner.next_source_window != result.windows:
            raise RuntimeError(f'paired combined source exact precompute incomplete for {runner.label}: windows={runner.next_source_window} expected={result.windows}')
        _finish_source_sum_audit(ctx)
    elif cfg.source.source_precompute_device_energy:
        if result.windows > runner.next_source_window:
            runner.next_source_window = _run_source_exact_precompute_stage(
                ctx,
                result,
                None,
                runner.source_stage_start_frame,
                runner.next_source_window,
                result.windows,
                device_energy_end_frame=runner.source_energy_stage_end_frame,
            )
        if runner.next_source_window != result.windows:
            raise RuntimeError(f'paired fused source device precompute incomplete for {runner.label}: windows={runner.next_source_window} expected={result.windows}')
        _finish_source_sum_audit(ctx)
    elif runner.source_stage is not None:
        if result.windows > runner.next_source_window:
            runner.next_source_window = _run_source_exact_precompute_stage(
                ctx,
                result,
                runner.source_stage,
                runner.source_stage_start_frame,
                runner.next_source_window,
                result.windows,
            )
        if runner.next_source_window != result.windows:
            raise RuntimeError(f'paired fused source exact precompute incomplete for {runner.label}: windows={runner.next_source_window} expected={result.windows}')
        _finish_source_sum_audit(ctx)
    combine_channel_sums(ctx, result, source_arg=ctx.bindings.start_states_arg, label=f'{runner.label}-combine-channel-sums')
    run_source_exact_precompute_pass(ctx, result)
    if runner.audit_tail is not None:
        _audit_ffmpeg_input_metrics(ctx, result, runner.audit_tail)
    ctx.emit_progress('stats_sums', 0.70)


def build_stats_context(cuda, args, cfg, buffers, kernels, bindings, state_bytes, host_io, a_coeffs, emit_progress):
    return StatsPassContext(
        cuda=cuda,
        args=args,
        cfg=cfg,
        buffers=buffers,
        kernels=kernels,
        bindings=bindings,
        state_bytes=state_bytes,
        host_io=host_io,
        a_coeffs=a_coeffs,
        emit_progress=emit_progress,
    )
