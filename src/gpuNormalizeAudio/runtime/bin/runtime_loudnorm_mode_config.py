from __future__ import annotations

import math
from dataclasses import dataclass

from runtime_env import env_flag


@dataclass(frozen=True)
class LoudnormModeConfig:
    apply_ffmpeg_timing: bool
    effective_tp: float
    exact_limiter_active: bool
    exact_limiter_max_bytes: int
    exact_limiter_requested: bool
    force_linear_mode: bool
    has_measured: bool
    limiter_bypass_safe: bool
    linear_f64_io: bool
    linear_mode: bool
    measured_values: object
    parallel_final_apply: bool
    runtime_offset_db: float


def derive_loudnorm_mode(args, *, stats_cache_only):
    measured_values = [args.measured_i, args.measured_lra, args.measured_tp, args.measured_thresh]
    has_measured = all(value is not None and math.isfinite(value) for value in measured_values)
    runtime_offset_db = args.offset_db if args.offset_db is not None and math.isfinite(args.offset_db) else 0.0
    linear_mode = False
    force_linear_mode = env_flag('LOUDNORM_GPU_FORCE_LINEAR_MODE')
    if args.ffmpeg_linear and has_measured and (force_linear_mode or env_flag('LOUDNORM_GPU_ALLOW_LINEAR_MODE', True)):
        linear_offset = args.target_i - args.measured_i
        offset_tp = args.measured_tp + linear_offset
        if force_linear_mode or (
            args.measured_tp != 99.0
            and args.measured_thresh != -70.0
            and args.measured_lra != 0.0
            and args.measured_i != 0.0
            and offset_tp <= args.target_tp
            and args.measured_lra <= args.target_lra
        ):
            linear_mode = True
            runtime_offset_db = linear_offset
    exact_limiter_requested = args.ffmpeg_limiter and args.input_format == 'f64le' and args.output_format == 'f64le' and (has_measured or stats_cache_only) and not linear_mode
    exact_limiter_max_bytes = int(max(0.0, args.ffmpeg_limiter_max_mib) * 1024 * 1024)
    effective_tp = args.target_tp - max(0.0, args.codec_headroom_db)
    limiter_bypass_safe = has_measured and ((args.measured_tp if args.measured_tp is not None else 0.0) + runtime_offset_db) <= (effective_tp + 1e-9)
    parallel_final_apply = exact_limiter_requested and args.parallel_final_apply and limiter_bypass_safe and env_flag('LOUDNORM_GPU_ALLOW_PARALLEL_FINAL_APPLY')
    exact_limiter_active = exact_limiter_requested and not parallel_final_apply
    apply_ffmpeg_timing = args.input_format == 'f64le' and has_measured and not linear_mode
    linear_f64_io = linear_mode and args.input_format == 'f64le' and args.output_format == 'f64le'
    return LoudnormModeConfig(
        apply_ffmpeg_timing=apply_ffmpeg_timing,
        effective_tp=effective_tp,
        exact_limiter_active=exact_limiter_active,
        exact_limiter_max_bytes=exact_limiter_max_bytes,
        exact_limiter_requested=exact_limiter_requested,
        force_linear_mode=force_linear_mode,
        has_measured=has_measured,
        limiter_bypass_safe=limiter_bypass_safe,
        linear_f64_io=linear_f64_io,
        linear_mode=linear_mode,
        measured_values=measured_values,
        parallel_final_apply=parallel_final_apply,
        runtime_offset_db=runtime_offset_db,
    )
