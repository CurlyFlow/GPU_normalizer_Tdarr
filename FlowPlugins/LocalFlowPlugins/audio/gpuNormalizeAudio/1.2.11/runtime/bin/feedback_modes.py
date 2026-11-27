from dataclasses import dataclass
from enum import Enum

from feedback_apply import (
    feedback_state_i_view,
    parallel_unsafe_feedback_status,
    segmented_safe_feedback_status,
)
from runtime_env import env_flag


class FeedbackApplyMode(Enum):
    SEGMENTED_SAFE = 'segmented_safe'
    PARALLEL_UNSAFE = 'parallel_unsafe'
    DIRECT = 'direct'


@dataclass(frozen=True)
class FeedbackLaunchPlan:
    local_windows: int
    mode: FeedbackApplyMode
    parallel_unsafe_fallback: bool
    record_segmented_safe_fallback: bool


def can_prefix_skip_safe_feedback(ctx, apply_chunk, feedback_state_i_host):
    cfg = ctx.cfg
    args = ctx.args
    state = feedback_state_i_view(feedback_state_i_host)
    return (
        cfg.exact.exact_safe_feedback_prefix
        and args.channels == 6
        and args.output_format == 'f64le'
        and apply_chunk.this_frames > 0
        and (apply_chunk.this_frames % cfg.input_shape.frames_per_window) == 0
        and state.enabled('skip_safe_fill')
        and not state.enabled('skip_safe_feedback')
        and state.enabled('prefilled_output')
        and state.enabled('prefill_chunk_safe')
        and not state.enabled('first')
        and state.enabled('above_threshold')
        and state.get('out_window_count') == 0
    )


def parallel_skip_before_threshold_6ch_enabled(cfg, args):
    return (
        args.channels == 6
        and cfg.exact.exact_safe_feedback_slot_accum
        and env_flag('LOUDNORM_GPU_PARALLEL_SKIP_BEFORE_THRESHOLD_6CH', True)
    )


def can_parallel_skip_safe_feedback(ctx, apply_chunk, feedback_state_i_host):
    cfg = ctx.cfg
    args = ctx.args
    state = feedback_state_i_view(feedback_state_i_host)
    threshold_ready = state.enabled('above_threshold')
    if cfg.exact.source_parallel_skip_before_threshold and cfg.source.source_exact_precompute:
        threshold_ready = True
    elif parallel_skip_before_threshold_6ch_enabled(cfg, args):
        threshold_ready = True
    return (
        cfg.exact.exact_parallel_skip_safe_feedback
        and not cfg.exact.exact_profile_counts
        and args.channels in (2, 6)
        and args.output_format == 'f64le'
        and apply_chunk.this_frames > 0
        and (apply_chunk.this_frames % cfg.input_shape.frames_per_window) == 0
        and not state.enabled('skip_safe_fill')
        and state.enabled('skip_safe_feedback')
        and not state.enabled('prefilled_output')
        and state.enabled('prefill_chunk_safe')
        and not state.enabled('first')
        and threshold_ready
        and state.get('out_window_count') == 0
    )


def select_feedback_apply_mode(ctx, apply_chunk, feedback_state_i_host, *, exact_chunk_unsafe, frame_offset, exact_prefinal_frames):
    cfg = ctx.cfg
    state = feedback_state_i_view(feedback_state_i_host)
    segmented_safe_chunk, segmented_safe_fallback = segmented_safe_feedback_status(
        ctx.args,
        exact_limiter_active=cfg.loudnorm_mode.exact_limiter_active,
        exact_segmented_safe_feedback=cfg.exact.exact_segmented_safe_feedback,
        exact_prefill_output=cfg.exact.exact_prefill_output,
        exact_chunk_unsafe=exact_chunk_unsafe,
        frame_offset=frame_offset,
        exact_prefinal_frames=exact_prefinal_frames,
        this_frames=apply_chunk.this_frames,
        frames_per_window=cfg.input_shape.frames_per_window,
        feedback_state_i_host=feedback_state_i_host,
    )
    parallel_unsafe = (
        not cfg.source.source_exact_precompute
        or state.enabled('above_threshold')
    ) and parallel_unsafe_feedback_status(
        ctx.args,
        exact_parallel_unsafe_feedback=cfg.exact.exact_parallel_unsafe_feedback,
        exact_chunk_unsafe=exact_chunk_unsafe,
        frame_offset=frame_offset,
        exact_prefinal_frames=exact_prefinal_frames,
        this_frames=apply_chunk.this_frames,
        frames_per_window=cfg.input_shape.frames_per_window,
        feedback_state_i_host=feedback_state_i_host,
    )
    mode = (
        FeedbackApplyMode.SEGMENTED_SAFE if segmented_safe_chunk
        else FeedbackApplyMode.PARALLEL_UNSAFE if parallel_unsafe
        else FeedbackApplyMode.DIRECT
    )
    return FeedbackLaunchPlan(
        local_windows=apply_chunk.this_frames // cfg.input_shape.frames_per_window,
        mode=mode,
        parallel_unsafe_fallback=parallel_unsafe,
        record_segmented_safe_fallback=segmented_safe_fallback,
    )
