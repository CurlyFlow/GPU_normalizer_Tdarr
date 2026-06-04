from __future__ import annotations

from types import SimpleNamespace

from feedback_apply import (
    feedback_state_i_view,
    parallel_unsafe_feedback_status,
    segmented_safe_feedback_status,
)


def can_prefix_skip_safe_feedback(ctx, apply_chunk, feedback_state_i_host):
    cfg = ctx.cfg
    args = ctx.args
    state = feedback_state_i_view(feedback_state_i_host)
    return (
        cfg.exact_safe_feedback_prefix
        and args.channels == 6
        and args.output_format == 'f64le'
        and apply_chunk.this_frames > 0
        and (apply_chunk.this_frames % cfg.frames_per_window) == 0
        and state.enabled('skip_safe_fill')
        and not state.enabled('skip_safe_feedback')
        and state.enabled('prefilled_output')
        and state.enabled('prefill_chunk_safe')
        and not state.enabled('first')
        and state.enabled('above_threshold')
        and state.get('out_window_count') == 0
    )


def can_parallel_skip_safe_feedback(ctx, apply_chunk, feedback_state_i_host):
    cfg = ctx.cfg
    args = ctx.args
    state = feedback_state_i_view(feedback_state_i_host)
    threshold_ready = state.enabled('above_threshold')
    if cfg.source_parallel_skip_before_threshold and cfg.source_exact_precompute:
        threshold_ready = True
    return (
        cfg.exact_parallel_skip_safe_feedback
        and not cfg.exact_profile_counts
        and args.channels in (2, 6)
        and args.output_format == 'f64le'
        and apply_chunk.this_frames > 0
        and (apply_chunk.this_frames % cfg.frames_per_window) == 0
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
        exact_limiter_active=cfg.exact_limiter_active,
        exact_segmented_safe_feedback=cfg.exact_segmented_safe_feedback,
        exact_prefill_output=cfg.exact_prefill_output,
        exact_chunk_unsafe=exact_chunk_unsafe,
        frame_offset=frame_offset,
        exact_prefinal_frames=exact_prefinal_frames,
        this_frames=apply_chunk.this_frames,
        frames_per_window=cfg.frames_per_window,
        feedback_state_i_host=feedback_state_i_host,
    )
    parallel_unsafe = (
        not cfg.source_exact_precompute
        or state.enabled('above_threshold')
    ) and parallel_unsafe_feedback_status(
        ctx.args,
        exact_parallel_unsafe_feedback=cfg.exact_parallel_unsafe_feedback,
        exact_chunk_unsafe=exact_chunk_unsafe,
        frame_offset=frame_offset,
        exact_prefinal_frames=exact_prefinal_frames,
        this_frames=apply_chunk.this_frames,
        frames_per_window=cfg.frames_per_window,
        feedback_state_i_host=feedback_state_i_host,
    )
    return SimpleNamespace(
        local_windows=apply_chunk.this_frames // cfg.frames_per_window,
        parallel_unsafe=parallel_unsafe,
        segmented_safe_chunk=segmented_safe_chunk,
        segmented_safe_fallback=segmented_safe_fallback,
    )
