from __future__ import annotations

import ctypes
import sys

from feedback_apply import (
    copy_feedback_state_i_from_device,
    copy_feedback_state_i_to_device,
    feedback_state_i_view,
)
from feedback_launchers import launch_apply_kernel, launch_sync_apply_kernel
import kernel_args
from runtime_profile import format_profile_stage


def _has_prelimiter_unsafe(ctx, first_window, last_window):
    window_end = min(ctx.cfg.windows, last_window)
    if first_window >= window_end:
        return False
    unsafe_prefix = getattr(ctx, 'prelimiter_unsafe_prefix', None)
    if unsafe_prefix is not None:
        return unsafe_prefix[window_end] > unsafe_prefix[first_window]
    return any(ctx.prelimiter_unsafe_flags[first_window:window_end])


def classify_exact_chunk(ctx, result, *, frame_offset, this_frames, exact_run_end_frame, exact_run_flag):
    cfg = ctx.cfg
    exact_chunk_unsafe = None
    if cfg.exact_limiter_active and ctx.prelimiter_unsafe_flags is not None:
        first_window = frame_offset // cfg.frames_per_window
        last_window = (frame_offset + this_frames + cfg.frames_per_window - 1) // cfg.frames_per_window
        exact_chunk_unsafe = _has_prelimiter_unsafe(ctx, first_window, last_window)
        if exact_chunk_unsafe:
            result.exact_unsafe_chunks += 1
        else:
            result.exact_safe_chunks += 1

    skip_safe_fill_chunk = False
    if cfg.exact_limiter_active and cfg.exact_skip_safe_fill and exact_chunk_unsafe is False and exact_run_flag == 0:
        safe_remaining_after_chunk = max(0, exact_run_end_frame - (frame_offset + this_frames))
        if safe_remaining_after_chunk >= cfg.exact_skip_safe_fill_margin_frames:
            skip_safe_fill_chunk = True
            result.exact_skip_safe_fill_chunks += 1
    return exact_chunk_unsafe, skip_safe_fill_chunk


def prefill_exact_output(ctx, result, feedback_state_i_host, *, frame_offset, this_samples, this_frames, input_base_arg, exact_chunk_unsafe, skip_safe_fill_chunk):
    cfg = ctx.cfg
    if not (cfg.exact_limiter_active and cfg.exact_prefill_output):
        return

    chunk_unsafe = exact_chunk_unsafe
    if chunk_unsafe is None:
        if ctx.prelimiter_unsafe_flags is not None:
            first_window = frame_offset // cfg.frames_per_window
            last_window = (frame_offset + this_frames + cfg.frames_per_window - 1) // cfg.frames_per_window
            chunk_unsafe = _has_prelimiter_unsafe(ctx, first_window, last_window)
        else:
            chunk_unsafe = True
    if not chunk_unsafe and cfg.exact_use_prefilled_output:
        n_prefill_arg = ctypes.c_uint32(this_samples)
        output_offset_arg = ctypes.c_uint32(frame_offset)
        prefill_args = kernel_args.build_prefill_args(
            ctx.bindings.in_arg,
            ctx.bindings.out_arg,
            ctx.bindings.gains_arg,
            ctx.bindings.gains_next_arg,
            n_prefill_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.windows_arg,
            output_offset_arg,
            input_base_arg,
            ctx.bindings.limiter_lookahead_arg,
            ctx.bindings.gain_timing_offset_arg,
            ctx.bindings.total_frames_arg,
            ctx.bindings.ceiling_arg,
        )
        prefill_grid = min(65535, max(1, (this_samples + 255) // 256))
        prefill_dt = launch_apply_kernel(ctx, 'apply-prefill', ctx.kernels.prefill_apply_fn, prefill_args, grid_x=prefill_grid, block_x=256, check_label='cuLaunchKernel(apply prefill exact output)')
        result.apply_kernel_time += prefill_dt
        result.exact_safe_kernel_time += prefill_dt
        result.exact_prefill_kernel_time += prefill_dt
    state = feedback_state_i_view(feedback_state_i_host)
    state.set_bool('prefilled_output', cfg.exact_use_prefilled_output)
    state.set_bool('prefill_chunk_safe', not chunk_unsafe)
    state.set_bool('skip_safe_fill', skip_safe_fill_chunk)
    state.set_bool('skip_safe_feedback', (not chunk_unsafe and cfg.exact_skip_safe_feedback) or (chunk_unsafe and cfg.exact_skip_unsafe_feedback))
    state.set_bool('force_safe_idle', skip_safe_fill_chunk and cfg.exact_force_safe_idle)
    state.set_bool('safe_feedback_window_accum', cfg.exact_safe_feedback_window_accum)
    state.set_bool('safe_feedback_slot_accum', cfg.exact_safe_feedback_slot_accum)
    state.set_bool('parallel_unsafe_feedback', cfg.exact_parallel_unsafe_feedback and exact_chunk_unsafe is True)
    copy_feedback_state_i_to_device(ctx.cuda, ctx.buffers.d_feedback_state_i, feedback_state_i_host, 'cuMemcpyHtoD(feedback_state_i chunk safe)')

def apply_exact_risk_gate(ctx, result, feedback_state_i_host, exact_chunk_unsafe, *, defer_copy=False):
    if not (ctx.cfg.exact_limiter_active and ctx.prelimiter_unsafe_flags is not None):
        return
    state = feedback_state_i_view(feedback_state_i_host)
    result.exact_risk_gate_total_chunks += 1
    if not exact_chunk_unsafe:
        result.exact_risk_gate_safe_chunks += 1
        if not (ctx.cfg.source_skip_limiter_lookahead_scan and ctx.args.channels == 2):
            state.set('limiter_maybe_above_ceiling', 0)
        if not defer_copy:
            copy_feedback_state_i_to_device(ctx.cuda, ctx.buffers.d_feedback_state_i, feedback_state_i_host, 'cuMemcpyHtoD(feedback_state_i safe risk gate)')


def refresh_exact_feedback_state(ctx, feedback_state_i_host, *, frame_offset, exact_transition_logged):
    if not ctx.cfg.exact_limiter_active:
        return exact_transition_logged
    copy_feedback_state_i_from_device(ctx.cuda, feedback_state_i_host, ctx.buffers.d_feedback_state_i, 'cuMemcpyDtoH(feedback_state_i)')
    state = feedback_state_i_view(feedback_state_i_host)
    if state.enabled('input_missing'):
        raise RuntimeError(f'exact limiter streaming input window missing at frame_offset={frame_offset}')
    return _log_exact_transition(
        feedback_state_i_host,
        frame_offset=frame_offset,
        exact_transition_logged=exact_transition_logged,
    )


def _log_exact_transition(feedback_state_i_host, *, frame_offset, exact_transition_logged):
    state = feedback_state_i_view(feedback_state_i_host)
    if exact_transition_logged or not state.enabled('above_threshold'):
        return exact_transition_logged
    print(format_profile_stage('exact_feedback_transition', [
        ('out_frame', state.get('out_frame')),
        ('input_window', state.get('input_window')),
        ('write_frame', state.get('write_frame')),
        ('frame_offset', frame_offset),
        ('limiter_maybe_above_ceiling', state.get('limiter_maybe_above_ceiling')),
    ]), file=sys.stderr)
    return True
