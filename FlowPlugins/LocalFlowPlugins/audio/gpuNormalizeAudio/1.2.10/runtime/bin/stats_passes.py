from __future__ import annotations

from stats_channel_pass import run_channel_stats_pass, run_exact_sums_pass
from stats_pass_state import StatsPassContext, StatsPassResult
from stats_q_sums import build_prefix_start_states, combine_channel_sums, run_q_state_pass, run_sums_pass
from stats_source_precompute import run_source_exact_precompute_pass


def run_stats_passes(cuda, args, *, cfg, buffers, kernels, bindings, state_bytes, host_io, a_coeffs, emit_progress):
    ctx = StatsPassContext(
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
    result = StatsPassResult(
        nbytes=cfg.input_shape.nbytes,
        mib=cfg.input_shape.mib,
        total_samples=cfg.input_shape.total_samples,
        total_frames=cfg.input_shape.total_frames,
        windows=cfg.input_shape.windows,
        seconds=cfg.input_shape.seconds,
        state_bytes=state_bytes,
    )

    if cfg.exact.exact_stats_stream:
        run_exact_sums_pass(ctx, result)
        return result

    if cfg.loudnorm_mode.exact_limiter_active and args.input_format == 'f64le' and not cfg.exact.exact_prefix_channel_stats:
        run_channel_stats_pass(ctx, result)
        run_source_exact_precompute_pass(ctx, result)
        return result

    run_q_state_pass(ctx, result)
    build_prefix_start_states(ctx, result)
    run_sums_pass(ctx, result)
    if cfg.exact.exact_prefix_channel_stats:
        combine_channel_sums(ctx, result, source_arg=bindings.channel_sums_arg, label='combine-prefix-channel-sums')
    return result
