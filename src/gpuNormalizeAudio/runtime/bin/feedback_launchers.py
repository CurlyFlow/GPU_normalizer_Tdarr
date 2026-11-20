from feedback_leaf_launchers import (
    launch_direct_apply_kernel,
    launch_parallel_skip_safe_feedback,
    launch_parallel_unsafe_feedback,
    launch_safe_feedback_apply,
)
from feedback_modes import FeedbackApplyMode, can_prefix_skip_safe_feedback, select_feedback_apply_mode
from feedback_prefix_launchers import launch_prefix_safe_feedback
from feedback_run_scan_launchers import launch_safe_run_scan_apply_6ch, launch_source_safe_run_scan_apply


def _launch_segmented_safe(ctx, result, apply_chunk, feedback_state_i_host, *, local_windows):
    cfg = ctx.cfg
    if launch_source_safe_run_scan_apply(ctx, result, apply_chunk, feedback_state_i_host, local_windows=local_windows):
        return True
    if launch_safe_run_scan_apply_6ch(ctx, result, apply_chunk, feedback_state_i_host, local_windows=local_windows):
        return True
    if launch_parallel_skip_safe_feedback(ctx, result, apply_chunk, feedback_state_i_host, local_windows=local_windows):
        return True
    if can_prefix_skip_safe_feedback(ctx, apply_chunk, feedback_state_i_host):
        launch_prefix_safe_feedback(ctx, result, apply_chunk, feedback_state_i_host, local_windows=local_windows)
        return True
    if cfg.source.source_exact_precompute:
        result.segmented_safe_feedback_profile.record_fallback()
        return False
    launch_safe_feedback_apply(ctx, result, apply_chunk, local_windows=local_windows)
    return True


def launch_sync_apply_kernel(ctx, result, apply_chunk, feedback_state_i_host, *, exact_chunk_unsafe, frame_offset, exact_prefinal_frames):
    plan = select_feedback_apply_mode(
        ctx,
        apply_chunk,
        feedback_state_i_host,
        exact_chunk_unsafe=exact_chunk_unsafe,
        frame_offset=frame_offset,
        exact_prefinal_frames=exact_prefinal_frames,
    )
    if plan.mode is FeedbackApplyMode.SEGMENTED_SAFE and _launch_segmented_safe(
        ctx,
        result,
        apply_chunk,
        feedback_state_i_host,
        local_windows=plan.local_windows,
    ):
        return

    if plan.mode is FeedbackApplyMode.PARALLEL_UNSAFE or plan.parallel_unsafe_fallback:
        launch_parallel_unsafe_feedback(ctx, result, apply_chunk, feedback_state_i_host, local_windows=plan.local_windows)
        return

    if plan.record_segmented_safe_fallback:
        result.segmented_safe_feedback_profile.record_fallback()
    launch_direct_apply_kernel(ctx, result, apply_chunk, exact_chunk_unsafe=exact_chunk_unsafe)
