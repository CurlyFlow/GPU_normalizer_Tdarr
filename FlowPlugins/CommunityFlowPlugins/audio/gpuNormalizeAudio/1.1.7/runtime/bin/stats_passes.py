from __future__ import annotations

from dataclasses import dataclass

from stats_subpasses import (
    build_prefix_start_states,
    combine_channel_sums,
    run_channel_stats_pass,
    run_exact_sums_pass,
    run_q_state_pass,
    run_sums_pass,
)


@dataclass
class StatsPassResult:
    nbytes: int
    mib: float
    total_samples: int
    total_frames: int
    windows: int
    seconds: float
    state_bytes: int
    stats_q_wall_time: float = 0.0
    stats_q_h2d_time: float = 0.0
    stats_q_kernel_time: float = 0.0
    stats_sums_wall_time: float = 0.0
    stats_sums_h2d_time: float = 0.0
    stats_sums_kernel_time: float = 0.0
    host_prefix_wall_time: float = 0.0
    host_prefix_cpu_time: float = 0.0
    host_prefix_d2h_time: float = 0.0
    host_prefix_h2d_time: float = 0.0
    total_h2d_time: float = 0.0
    total_d2h_time: float = 0.0


@dataclass
class StatsPassContext:
    cuda: object
    args: object
    cfg: object
    buffers: object
    kernels: object
    bindings: object
    state_bytes: int
    host_io: object
    a_coeffs: object
    emit_progress: object


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
        nbytes=cfg.nbytes,
        mib=cfg.mib,
        total_samples=cfg.total_samples,
        total_frames=cfg.total_frames,
        windows=cfg.windows,
        seconds=cfg.seconds,
        state_bytes=state_bytes,
    )

    if cfg.exact_stats_stream:
        run_exact_sums_pass(ctx, result)
        return result

    if cfg.exact_limiter_active and args.input_format == 'f64le' and not cfg.exact_prefix_channel_stats:
        run_channel_stats_pass(ctx, result)
        return result

    run_q_state_pass(ctx, result)
    build_prefix_start_states(ctx, result)
    run_sums_pass(ctx, result)
    if cfg.exact_prefix_channel_stats:
        combine_channel_sums(ctx, result, source_arg=bindings.channel_sums_arg, label='combine-prefix-channel-sums')
    return result
