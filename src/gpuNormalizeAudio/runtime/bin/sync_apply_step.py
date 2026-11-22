import time

from feedback_launchers import launch_sync_apply_kernel
from first_pass_output_capture import capture_first_pass_output_metrics
from sync_apply_chunks import prepare_sync_apply_chunk
from sync_apply_input import copy_sync_input, safe_skip_chunk_bytes
from sync_apply_output import copy_sync_output
from short_source import is_short_first_frame, run_short_first_frame
from sync_feedback_classify import classify_exact_chunk
from sync_feedback_state import (
    apply_exact_risk_gate,
    prefill_exact_output,
    refresh_exact_feedback_state,
)


def run_sync_apply_step(ctx, result, state):
    cfg = ctx.cfg
    if not state.active or state.done_bytes >= cfg.input_shape.nbytes:
        state.active = False
        return False
    if is_short_first_frame(ctx.args, cfg):
        return run_short_first_frame(ctx, result, state)
    if state.async_output is not None:
        state.async_output.select_output(ctx)
    apply_chunk = prepare_sync_apply_chunk(
        ctx,
        result,
        state.fi,
        state.exact_stream_window,
        done_bytes=state.done_bytes,
        frame_offset=state.frame_offset,
        exact_use_final_flush=state.exact_use_final_flush,
        exact_prefinal_frames=state.exact_prefinal_frames,
        exact_final_flush_frames=state.exact_final_flush_frames,
        exact_safe_skip_chunk_bytes=safe_skip_chunk_bytes(ctx, state),
    )
    if apply_chunk is None:
        state.active = False
        return False
    stage_t0 = time.perf_counter()
    exact_chunk_unsafe, skip_safe_fill_chunk = classify_exact_chunk(
        ctx,
        result,
        frame_offset=state.frame_offset,
        this_frames=apply_chunk.this_frames,
        exact_run_end_frame=apply_chunk.exact_run_end_frame,
        exact_run_flag=apply_chunk.exact_run_flag,
    )

    copy_sync_input(ctx, result, apply_chunk.copy_input_bytes)
    apply_exact_risk_gate(
        ctx,
        result,
        state.feedback_state_i_host,
        exact_chunk_unsafe,
        defer_copy=cfg.exact.defer_safe_risk_gate_copy,
    )
    prefill_exact_output(
        ctx,
        result,
        state.feedback_state_i_host,
        frame_offset=state.frame_offset,
        this_samples=apply_chunk.this_samples,
        this_frames=apply_chunk.this_frames,
        input_base_arg=apply_chunk.input_base_arg,
        exact_chunk_unsafe=exact_chunk_unsafe,
        skip_safe_fill_chunk=skip_safe_fill_chunk,
    )
    launch_sync_apply_kernel(
        ctx,
        result,
        apply_chunk,
        state.feedback_state_i_host,
        exact_chunk_unsafe=exact_chunk_unsafe,
        frame_offset=state.frame_offset,
        exact_prefinal_frames=state.exact_prefinal_frames,
    )
    capture_first_pass_output_metrics(ctx, result, apply_chunk)

    state.exact_transition_logged = refresh_exact_feedback_state(
        ctx,
        state.feedback_state_i_host,
        frame_offset=state.frame_offset,
        exact_transition_logged=state.exact_transition_logged,
    )
    copy_sync_output(
        ctx,
        result,
        state.fo,
        this_output_bytes=apply_chunk.this_output_bytes,
        stage_t0=stage_t0,
        async_output=state.async_output,
        borrowed_output=state.borrowed_output,
        this_frames=apply_chunk.this_frames,
        frame_offset=state.frame_offset,
        swr_downsampler=state.swr_downsampler,
        is_final=(state.frame_offset + apply_chunk.this_frames >= cfg.input_shape.total_frames),
    )
    state.done_bytes += apply_chunk.this_bytes
    state.frame_offset += apply_chunk.this_frames
    ctx.emit_progress('apply', 0.75 + 0.25 * (state.done_bytes / float(cfg.input_shape.nbytes)))
    if state.done_bytes >= cfg.input_shape.nbytes:
        state.active = False
    return True
