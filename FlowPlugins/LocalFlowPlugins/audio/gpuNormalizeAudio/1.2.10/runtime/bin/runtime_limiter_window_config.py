from __future__ import annotations

from dataclasses import dataclass

from loudnorm_math import db_to_amp, frame_size
from runtime_env import env_float, env_int


@dataclass(frozen=True)
class LimiterWindowConfig:
    ceiling: float
    apply_ceiling: float
    limiter_lookahead_frames: int
    limiter_alloc_frames: int
    final_flush_frames: int
    audit_input_tail_frames: int
    audit_input_replay_frames: int
    exact_skip_safe_fill_margin_frames: int
    exact_risk_expand_windows: int
    exact_risk_expand_before_windows: int
    exact_risk_expand_after_windows: int
    exact_risk_ceiling_scale: float
    exact_use_risk_map: bool


def derive_limiter_window_config(args, *, frames_per_window, effective_tp, linear_mode, exact_limiter_active, exact_skip_safe_fill, source_faithful_stereo, source_segmented_safe_feedback):
    ceiling = db_to_amp(effective_tp)
    apply_ceiling = 3.4028234663852886e38 if linear_mode else ceiling
    limiter_lookahead_frames = frame_size(args.rate, 210)
    limiter_alloc_frames = frame_size(args.rate, 3000)
    final_flush_frames = max(0, frames_per_window * 30 - frames_per_window)
    audit_input_tail_frames = frames_per_window * 30
    audit_input_replay_frames = final_flush_frames
    exact_skip_safe_fill_margin_frames = 0 if exact_skip_safe_fill else limiter_lookahead_frames
    if exact_skip_safe_fill:
        margin_windows = env_float('LOUDNORM_GPU_SKIP_SAFE_FILL_MARGIN_WINDOWS', 0.0)
        if margin_windows >= 0.0:
            exact_skip_safe_fill_margin_frames = int(margin_windows * frames_per_window)
    exact_risk_expand_windows = 1
    if exact_limiter_active:
        exact_risk_expand_windows = env_int('LOUDNORM_GPU_RISK_EXPAND_WINDOWS', exact_risk_expand_windows, minimum=0, invalid_default=3)
    exact_risk_expand_before_windows = exact_risk_expand_windows
    exact_risk_expand_after_windows = exact_risk_expand_windows
    # Keep the risk map slightly conservative: dynamic feedback can lift later gains enough
    # that near-ceiling windows otherwise get misclassified as safe on long 2ch renders.
    exact_risk_ceiling_scale = 0.97
    exact_use_risk_map = exact_limiter_active and ((not source_faithful_stereo) or source_segmented_safe_feedback)
    if exact_limiter_active:
        exact_risk_expand_before_windows = env_int('LOUDNORM_GPU_RISK_EXPAND_BEFORE_WINDOWS', exact_risk_expand_before_windows, minimum=0)
        exact_risk_expand_after_windows = env_int('LOUDNORM_GPU_RISK_EXPAND_AFTER_WINDOWS', exact_risk_expand_after_windows, minimum=0)
        exact_risk_ceiling_scale = env_float('LOUDNORM_GPU_RISK_CEILING_SCALE', exact_risk_ceiling_scale, minimum=0.0, invalid_default=1.0)
    return LimiterWindowConfig(
        ceiling=ceiling,
        apply_ceiling=apply_ceiling,
        limiter_lookahead_frames=limiter_lookahead_frames,
        limiter_alloc_frames=limiter_alloc_frames,
        final_flush_frames=final_flush_frames,
        audit_input_tail_frames=audit_input_tail_frames,
        audit_input_replay_frames=audit_input_replay_frames,
        exact_skip_safe_fill_margin_frames=exact_skip_safe_fill_margin_frames,
        exact_risk_expand_windows=exact_risk_expand_windows,
        exact_risk_expand_before_windows=exact_risk_expand_before_windows,
        exact_risk_expand_after_windows=exact_risk_expand_after_windows,
        exact_risk_ceiling_scale=exact_risk_ceiling_scale,
        exact_use_risk_map=exact_use_risk_map,
    )
