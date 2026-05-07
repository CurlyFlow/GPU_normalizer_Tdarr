from __future__ import annotations

import array
import ctypes
import sys
import time

from cuda_driver import chk
from cuda_launch import launch_timed_kernel
from feedback_apply import (
    FB_I_ABOVE_THRESHOLD,
    FB_I_FIRST,
    FB_I_INPUT_MISSING,
    FB_I_INPUT_WINDOW,
    FB_I_LIMITER_MAYBE_ABOVE_CEILING,
    FB_I_OUT_WINDOW_COUNT,
    FB_I_PARALLEL_UNSAFE_FEEDBACK,
    FB_I_FORCE_SAFE_IDLE,
    FB_I_OUT_FRAME,
    FB_I_PREFILLED_OUTPUT,
    FB_I_PREFILL_CHUNK_SAFE,
    FB_I_SAFE_FEEDBACK_SLOT_ACCUM,
    FB_I_SAFE_FEEDBACK_WINDOW_ACCUM,
    FB_I_SKIP_SAFE_FEEDBACK,
    FB_I_SKIP_SAFE_FILL,
    FB_I_WRITE_FRAME,
    FB_D_OUT_STATES,
    FB_D_OUT_STATE_VALUES,
    FEEDBACK_STATE_D_WORDS,
    copy_feedback_out_states_to_device,
    copy_feedback_state_d_from_device,
    copy_feedback_state_i_from_device,
    copy_feedback_state_i_to_device,
    parallel_unsafe_feedback_status,
    segmented_safe_feedback_status,
)
import kernel_args
from kweight_state import build_start_states
from runtime_profile import format_profile_stage


CHANNEL_TO_SLOT_6 = (0, 1, 2, -1, 3, 4)


def classify_exact_chunk(ctx, result, *, frame_offset, this_frames, exact_run_end_frame, exact_run_flag):
    cfg = ctx.cfg
    exact_chunk_unsafe = None
    if cfg.exact_limiter_active and ctx.prelimiter_unsafe_flags is not None:
        first_window = frame_offset // cfg.frames_per_window
        last_window = (frame_offset + this_frames + cfg.frames_per_window - 1) // cfg.frames_per_window
        exact_chunk_unsafe = any(ctx.prelimiter_unsafe_flags[first_window:min(cfg.windows, last_window)])
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
            chunk_unsafe = any(ctx.prelimiter_unsafe_flags[first_window:min(cfg.windows, last_window)])
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
        prefill_dt = launch_timed_kernel(ctx.cuda, 'apply-prefill', ctx.kernels.prefill_apply_fn, prefill_args, grid_x=prefill_grid, block_x=256, check_label='cuLaunchKernel(apply prefill exact output)')
        result.apply_kernel_time += prefill_dt
        result.exact_safe_kernel_time += prefill_dt
        result.exact_prefill_kernel_time += prefill_dt
    feedback_state_i_host[FB_I_PREFILLED_OUTPUT] = 1 if cfg.exact_use_prefilled_output else 0
    feedback_state_i_host[FB_I_PREFILL_CHUNK_SAFE] = 0 if chunk_unsafe else 1
    feedback_state_i_host[FB_I_SKIP_SAFE_FILL] = 1 if skip_safe_fill_chunk else 0
    feedback_state_i_host[FB_I_SKIP_SAFE_FEEDBACK] = 1 if (not chunk_unsafe and cfg.exact_skip_safe_feedback) else 0
    feedback_state_i_host[FB_I_FORCE_SAFE_IDLE] = 1 if skip_safe_fill_chunk and cfg.exact_force_safe_idle else 0
    feedback_state_i_host[FB_I_SAFE_FEEDBACK_WINDOW_ACCUM] = 1 if cfg.exact_safe_feedback_window_accum else 0
    feedback_state_i_host[FB_I_SAFE_FEEDBACK_SLOT_ACCUM] = 1 if cfg.exact_safe_feedback_slot_accum else 0
    feedback_state_i_host[FB_I_PARALLEL_UNSAFE_FEEDBACK] = 1 if cfg.exact_parallel_unsafe_feedback and exact_chunk_unsafe is True else 0
    copy_feedback_state_i_to_device(ctx.cuda, ctx.buffers.d_feedback_state_i, feedback_state_i_host, 'cuMemcpyHtoD(feedback_state_i chunk safe)')


def _can_prefix_skip_safe_feedback(ctx, apply_chunk, feedback_state_i_host):
    cfg = ctx.cfg
    args = ctx.args
    return (
        cfg.exact_safe_feedback_prefix
        and args.channels == 6
        and args.output_format == 'f64le'
        and apply_chunk.this_frames > 0
        and (apply_chunk.this_frames % cfg.frames_per_window) == 0
        and feedback_state_i_host[FB_I_SKIP_SAFE_FILL] != 0
        and feedback_state_i_host[FB_I_SKIP_SAFE_FEEDBACK] == 0
        and feedback_state_i_host[FB_I_PREFILLED_OUTPUT] != 0
        and feedback_state_i_host[FB_I_PREFILL_CHUNK_SAFE] != 0
        and feedback_state_i_host[FB_I_FIRST] == 0
        and feedback_state_i_host[FB_I_ABOVE_THRESHOLD] != 0
        and feedback_state_i_host[FB_I_OUT_WINDOW_COUNT] == 0
    )


def _can_parallel_skip_safe_feedback(ctx, apply_chunk, feedback_state_i_host):
    cfg = ctx.cfg
    args = ctx.args
    return (
        cfg.exact_parallel_skip_safe_feedback
        and not cfg.exact_profile_counts
        and args.channels == 6
        and args.output_format == 'f64le'
        and apply_chunk.this_frames > 0
        and (apply_chunk.this_frames % cfg.frames_per_window) == 0
        and feedback_state_i_host[FB_I_SKIP_SAFE_FILL] == 0
        and feedback_state_i_host[FB_I_SKIP_SAFE_FEEDBACK] != 0
        and feedback_state_i_host[FB_I_PREFILLED_OUTPUT] == 0
        and feedback_state_i_host[FB_I_PREFILL_CHUNK_SAFE] != 0
        and feedback_state_i_host[FB_I_FIRST] == 0
        and feedback_state_i_host[FB_I_ABOVE_THRESHOLD] != 0
        and feedback_state_i_host[FB_I_OUT_WINDOW_COUNT] == 0
    )


def _channel_start_states_from_feedback(feedback_state_d_host):
    states = array.array('d', [0.0]) * (6 * 4)
    for c, slot in enumerate(CHANNEL_TO_SLOT_6):
        if slot < 0:
            continue
        src = FB_D_OUT_STATES + (slot * 4)
        dst = c * 4
        states[dst + 0] = feedback_state_d_host[src + 0]
        states[dst + 1] = feedback_state_d_host[src + 1]
        states[dst + 2] = feedback_state_d_host[src + 2]
        states[dst + 3] = feedback_state_d_host[src + 3]
    return states


def _feedback_out_states_from_channels(channel_states):
    out_states = array.array('d', [0.0]) * FB_D_OUT_STATE_VALUES
    for c, slot in enumerate(CHANNEL_TO_SLOT_6):
        if slot < 0:
            continue
        src = c * 4
        dst = slot * 4
        out_states[dst + 0] = channel_states[src + 0]
        out_states[dst + 1] = channel_states[src + 1]
        out_states[dst + 2] = channel_states[src + 2]
        out_states[dst + 3] = channel_states[src + 3]
    return out_states


def _launch_prefix_safe_feedback(ctx, result, apply_chunk, feedback_state_i_host, *, local_windows):
    cfg = ctx.cfg
    bindings = ctx.bindings
    cuda = ctx.cuda
    channel_state_bytes = ctx.args.channels * 4 * 8
    frames_arg = ctypes.c_uint32(apply_chunk.this_frames)
    local_windows_arg = ctypes.c_uint32(local_windows)
    window_offset_arg = ctypes.c_uint32(0)

    if not cfg.exact_safe_feedback_prefix_energy:
        out_frame_start = feedback_state_i_host[FB_I_OUT_FRAME]
        write_frame_start = feedback_state_i_host[FB_I_WRITE_FRAME]
        lead_frames = write_frame_start - out_frame_start if write_frame_start >= out_frame_start else 0
        fill_gain_lead = (lead_frames + cfg.frames_per_window - 1) // cfg.frames_per_window
        fill_gain_count = fill_gain_lead + local_windows + 2
        null_feedback_arg = ctypes.c_uint64(0)
        fill_gain_lead_arg = ctypes.c_uint32(fill_gain_lead)
        fill_gain_count_arg = ctypes.c_uint32(fill_gain_count)
        stitch_args = kernel_args.build_safe_feedback_stitch_args(
            bindings.feedback_state_i_arg,
            bindings.feedback_state_d_arg,
            bindings.feedback_hist_arg,
            bindings.out_arg,
            bindings.limiter_prev_arg,
            bindings.sums_arg,
            null_feedback_arg,
            bindings.hist_energies_arg,
            bindings.hist_boundaries_arg,
            local_windows_arg,
            bindings.total_frames_arg,
            bindings.channels_arg,
            bindings.frame_window_arg,
            bindings.windows_arg,
            bindings.limiter_lookahead_arg,
            bindings.exact_target_i_arg,
            bindings.exact_target_lra_arg,
            bindings.exact_measured_i_arg,
            bindings.exact_measured_thresh_arg,
            bindings.exact_limiter_ceiling_arg,
            bindings.q_states_arg,
            fill_gain_lead_arg,
            fill_gain_count_arg,
        )
        stitch_dt = launch_timed_kernel(cuda, 'safe-feedback-prefix-plan-stitch', ctx.kernels.safe_feedback_stitch_fn, stitch_args)
        output_frame_arg = ctypes.c_uint32(out_frame_start)
        write_frame_arg = ctypes.c_uint32(write_frame_start)
        fill_frames = apply_chunk.this_frames + lead_frames
        samples_arg = ctypes.c_uint32(fill_frames * ctx.args.channels)
        output_frames_arg = ctypes.c_uint32(apply_chunk.this_frames)
        fill_args = kernel_args.build_safe_feedback_fill_args(
            bindings.in_arg,
            bindings.out_arg,
            bindings.limiter_buf_arg,
            bindings.q_states_arg,
            samples_arg,
            output_frames_arg,
            bindings.channels_arg,
            bindings.frame_window_arg,
            bindings.limiter_lookahead_arg,
            output_frame_arg,
            apply_chunk.input_base_arg,
            apply_chunk.input_frames_arg,
            write_frame_arg,
            fill_gain_lead_arg,
            fill_gain_count_arg,
            bindings.exact_offset_amp_arg,
            bindings.exact_limiter_ceiling_arg,
        )
        fill_grid = min(65535, max(1, (samples_arg.value + 255) // 256))
        fill_dt = launch_timed_kernel(cuda, 'safe-feedback-prefix-fill', ctx.kernels.safe_feedback_fill_fn, fill_args, grid_x=fill_grid, block_x=256)
        kernel_dt = stitch_dt + fill_dt
        result.apply_kernel_time += kernel_dt
        result.exact_safe_kernel_time += kernel_dt
        result.exact_safe_apply_kernel_time += kernel_dt
        result.segmented_safe_feedback_profile.record_prefix(0.0, fill_dt, stitch_dt, local_windows)
        return 0.0

    d2h_dt = 0.0
    h2d_dt = 0.0
    energy_dt = 0.0
    if cfg.exact_safe_feedback_prefix_energy:
        energy_args = kernel_args.build_safe_feedback_energy_args(
            bindings.out_arg,
            bindings.safe_feedback_frames_arg,
            bindings.feedback_state_d_arg,
            frames_arg,
            bindings.channels_arg,
            bindings.b_arg,
            bindings.a_arg,
        )
        energy_dt = launch_timed_kernel(cuda, 'safe-feedback-prefix-energy', ctx.kernels.safe_feedback_energy_fn, energy_args, grid_x=ctx.args.channels, block_x=1)
        window_grid = min(65535, max(1, (local_windows + 255) // 256))
        window_args = kernel_args.build_safe_feedback_window_args(
            bindings.safe_feedback_frames_arg,
            bindings.q_states_arg,
            frames_arg,
            bindings.frame_window_arg,
        )
        window_dt = launch_timed_kernel(cuda, 'safe-feedback-prefix-window', ctx.kernels.safe_feedback_window_fn, window_args, grid_x=window_grid, block_x=256)
    else:
        feedback_state_d_host = array.array('d', [0.0]) * FEEDBACK_STATE_D_WORDS
        t0 = time.perf_counter()
        copy_feedback_state_d_from_device(cuda, feedback_state_d_host, ctx.buffers.d_feedback_state_d, 'cuMemcpyDtoH(prefix feedback_state_d)')
        state_d_d2h_dt = time.perf_counter() - t0

        channel_states = _channel_start_states_from_feedback(feedback_state_d_host)
        t0 = time.perf_counter()
        chk(cuda.cuMemcpyHtoD_v2(ctx.buffers.d_start_states, ctypes.c_void_p(channel_states.buffer_info()[0]), channel_state_bytes), 'cuMemcpyHtoD(prefix channel states)')
        start_h2d_dt = time.perf_counter() - t0

        channel_args = kernel_args.build_channel_stats_args(
            bindings.out_arg,
            bindings.channel_sums_arg,
            bindings.peaks_arg,
            bindings.start_states_arg,
            frames_arg,
            bindings.channels_arg,
            bindings.frame_window_arg,
            window_offset_arg,
            bindings.b_arg,
            bindings.a_arg,
        )
        channel_dt = launch_timed_kernel(cuda, 'safe-feedback-prefix-channel-seq', ctx.kernels.channel_sums_fn, channel_args, grid_x=ctx.args.channels, block_x=1)

        final_channel_states = array.array('d', [0.0]) * (ctx.args.channels * 4)
        t0 = time.perf_counter()
        chk(cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(final_channel_states.buffer_info()[0]), ctx.buffers.d_start_states, channel_state_bytes), 'cuMemcpyDtoH(prefix final channel states)')
        final_state_d2h_dt = time.perf_counter() - t0

        final_out_states = _feedback_out_states_from_channels(final_channel_states)
        t0 = time.perf_counter()
        copy_feedback_out_states_to_device(cuda, ctx.buffers.d_feedback_state_d, final_out_states, 'cuMemcpyHtoD(prefix out_states)')
        out_state_h2d_dt = time.perf_counter() - t0

        combine_grid = min(65535, max(1, (local_windows + 255) // 256))
        combine_args = kernel_args.build_combine_sums_args(bindings.channel_sums_arg, bindings.q_states_arg, local_windows_arg, bindings.channels_arg)
        combine_dt = launch_timed_kernel(cuda, 'safe-feedback-prefix-combine', ctx.kernels.combine_sums_fn, combine_args, grid_x=combine_grid, block_x=256)
        d2h_dt = state_d_d2h_dt + final_state_d2h_dt
        h2d_dt = start_h2d_dt + out_state_h2d_dt
        window_dt = channel_dt + combine_dt

    null_fill_arg = ctypes.c_uint64(0)
    zero_fill_lead_arg = ctypes.c_uint32(0)
    zero_fill_count_arg = ctypes.c_uint32(0)
    stitch_args = kernel_args.build_safe_feedback_stitch_args(
        bindings.feedback_state_i_arg,
        bindings.feedback_state_d_arg,
        bindings.feedback_hist_arg,
        bindings.out_arg,
        bindings.limiter_prev_arg,
        bindings.sums_arg,
        bindings.q_states_arg,
        bindings.hist_energies_arg,
        bindings.hist_boundaries_arg,
        local_windows_arg,
        bindings.total_frames_arg,
        bindings.channels_arg,
        bindings.frame_window_arg,
        bindings.windows_arg,
        bindings.limiter_lookahead_arg,
        bindings.exact_target_i_arg,
        bindings.exact_target_lra_arg,
        bindings.exact_measured_i_arg,
        bindings.exact_measured_thresh_arg,
        bindings.exact_limiter_ceiling_arg,
        null_fill_arg,
        zero_fill_lead_arg,
        zero_fill_count_arg,
    )
    stitch_dt = launch_timed_kernel(cuda, 'safe-feedback-prefix-stitch', ctx.kernels.safe_feedback_stitch_fn, stitch_args)

    kernel_dt = energy_dt + window_dt + stitch_dt
    result.apply_d2h_time += d2h_dt
    result.total_d2h_time += d2h_dt
    result.apply_h2d_time += h2d_dt
    result.total_h2d_time += h2d_dt
    result.apply_kernel_time += kernel_dt
    result.exact_safe_kernel_time += kernel_dt
    result.exact_safe_apply_kernel_time += kernel_dt
    result.segmented_safe_feedback_profile.record_prefix(energy_dt, window_dt, stitch_dt, local_windows)
    return 0.0


def launch_sync_apply_kernel(ctx, result, apply_chunk, feedback_state_i_host, *, exact_chunk_unsafe, frame_offset, exact_prefinal_frames):
    cfg = ctx.cfg
    bindings = ctx.bindings
    segmented_safe_feedback_chunk, segmented_safe_feedback_fallback = segmented_safe_feedback_status(
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
    if segmented_safe_feedback_chunk:
        local_windows = apply_chunk.this_frames // cfg.frames_per_window
        if _can_parallel_skip_safe_feedback(ctx, apply_chunk, feedback_state_i_host):
            frames_arg = ctypes.c_uint32(apply_chunk.this_frames)
            skip_apply_args = kernel_args.build_safe_feedback_apply6_args(
                bindings.in_arg,
                bindings.out_arg,
                bindings.sums_arg,
                bindings.hist_energies_arg,
                bindings.hist_boundaries_arg,
                bindings.limiter_buf_arg,
                bindings.limiter_prev_arg,
                bindings.feedback_state_i_arg,
                bindings.feedback_state_d_arg,
                bindings.feedback_hist_arg,
                bindings.safe_feedback_frames_arg,
                bindings.total_frames_arg,
                apply_chunk.input_base_arg,
                apply_chunk.input_frames_arg,
                frames_arg,
                bindings.channels_arg,
                bindings.frame_window_arg,
                bindings.windows_arg,
                bindings.limiter_lookahead_arg,
                bindings.attack_length_arg,
                bindings.release_length_arg,
                bindings.b_arg,
                bindings.a_arg,
                bindings.exact_target_i_arg,
                bindings.exact_target_lra_arg,
                bindings.exact_measured_i_arg,
                bindings.exact_measured_thresh_arg,
                bindings.exact_offset_amp_arg,
                bindings.exact_limiter_ceiling_arg,
            )
            apply_dt = launch_timed_kernel(ctx.cuda, 'safe-feedback-skip-parallel6', ctx.kernels.safe_feedback_skip_apply_fn, skip_apply_args, block_x=256)
            result.apply_kernel_time += apply_dt
            result.exact_safe_kernel_time += apply_dt
            result.exact_safe_apply_kernel_time += apply_dt
            result.segmented_safe_feedback_profile.record_parallel_skip(apply_dt, local_windows)
            return
        if _can_prefix_skip_safe_feedback(ctx, apply_chunk, feedback_state_i_host):
            _launch_prefix_safe_feedback(ctx, result, apply_chunk, feedback_state_i_host, local_windows=local_windows)
            return
        frames_arg = ctypes.c_uint32(apply_chunk.this_frames)
        safe_apply_args = kernel_args.build_safe_feedback_apply6_args(
            bindings.in_arg,
            bindings.out_arg,
            bindings.sums_arg,
            bindings.hist_energies_arg,
            bindings.hist_boundaries_arg,
            bindings.limiter_buf_arg,
            bindings.limiter_prev_arg,
            bindings.feedback_state_i_arg,
            bindings.feedback_state_d_arg,
            bindings.feedback_hist_arg,
            bindings.safe_feedback_frames_arg,
            bindings.total_frames_arg,
            apply_chunk.input_base_arg,
            apply_chunk.input_frames_arg,
            frames_arg,
            bindings.channels_arg,
            bindings.frame_window_arg,
            bindings.windows_arg,
            bindings.limiter_lookahead_arg,
            bindings.attack_length_arg,
            bindings.release_length_arg,
            bindings.b_arg,
            bindings.a_arg,
            bindings.exact_target_i_arg,
            bindings.exact_target_lra_arg,
            bindings.exact_measured_i_arg,
            bindings.exact_measured_thresh_arg,
            bindings.exact_offset_amp_arg,
            bindings.exact_limiter_ceiling_arg,
        )
        apply_dt = launch_timed_kernel(ctx.cuda, 'safe-feedback-apply6', ctx.kernels.safe_feedback_apply_fn, safe_apply_args, block_x=6)
        result.apply_kernel_time += apply_dt
        result.exact_safe_kernel_time += apply_dt
        result.exact_safe_apply_kernel_time += apply_dt
        result.segmented_safe_feedback_profile.record_apply(apply_dt, local_windows)
        return

    if parallel_unsafe_feedback_status(
        ctx.args,
        exact_parallel_unsafe_feedback=cfg.exact_parallel_unsafe_feedback,
        exact_chunk_unsafe=exact_chunk_unsafe,
        frame_offset=frame_offset,
        exact_prefinal_frames=exact_prefinal_frames,
        this_frames=apply_chunk.this_frames,
        frames_per_window=cfg.frames_per_window,
        feedback_state_i_host=feedback_state_i_host,
    ):
        local_windows = apply_chunk.this_frames // cfg.frames_per_window
        frames_arg = ctypes.c_uint32(apply_chunk.this_frames)
        unsafe_apply_args = kernel_args.build_safe_feedback_apply6_args(
            bindings.in_arg,
            bindings.out_arg,
            bindings.sums_arg,
            bindings.hist_energies_arg,
            bindings.hist_boundaries_arg,
            bindings.limiter_buf_arg,
            bindings.limiter_prev_arg,
            bindings.feedback_state_i_arg,
            bindings.feedback_state_d_arg,
            bindings.feedback_hist_arg,
            bindings.safe_feedback_frames_arg,
            bindings.total_frames_arg,
            apply_chunk.input_base_arg,
            apply_chunk.input_frames_arg,
            frames_arg,
            bindings.channels_arg,
            bindings.frame_window_arg,
            bindings.windows_arg,
            bindings.limiter_lookahead_arg,
            bindings.attack_length_arg,
            bindings.release_length_arg,
            bindings.b_arg,
            bindings.a_arg,
            bindings.exact_target_i_arg,
            bindings.exact_target_lra_arg,
            bindings.exact_measured_i_arg,
            bindings.exact_measured_thresh_arg,
            bindings.exact_offset_amp_arg,
            bindings.exact_limiter_ceiling_arg,
        )
        apply_dt = launch_timed_kernel(ctx.cuda, 'unsafe-feedback-apply6', ctx.kernels.safe_feedback_apply_fn, unsafe_apply_args, block_x=6)
        result.apply_kernel_time += apply_dt
        result.exact_unsafe_kernel_time += apply_dt
        result.exact_unsafe_apply_kernel_time += apply_dt
        result.segmented_safe_feedback_profile.record_unsafe_apply(apply_dt, local_windows)
        return

    if segmented_safe_feedback_fallback:
        result.segmented_safe_feedback_profile.record_fallback()
    apply_dt = launch_timed_kernel(ctx.cuda, 'apply', ctx.kernels.apply_fn, apply_chunk.apply_args, grid_x=apply_chunk.grid_samples, block_x=1 if cfg.exact_limiter_active else 256, check_label=f'cuLaunchKernel({apply_chunk.kernel_label})')
    result.apply_kernel_time += apply_dt
    if cfg.exact_limiter_active and exact_chunk_unsafe is not None:
        if exact_chunk_unsafe:
            result.exact_unsafe_kernel_time += apply_dt
            result.exact_unsafe_apply_kernel_time += apply_dt
        else:
            result.exact_safe_kernel_time += apply_dt
            result.exact_safe_apply_kernel_time += apply_dt


def apply_exact_risk_gate(ctx, result, feedback_state_i_host, exact_chunk_unsafe):
    if not (ctx.cfg.exact_limiter_active and ctx.prelimiter_unsafe_flags is not None):
        return
    result.exact_risk_gate_total_chunks += 1
    if not exact_chunk_unsafe:
        result.exact_risk_gate_safe_chunks += 1
        feedback_state_i_host[FB_I_LIMITER_MAYBE_ABOVE_CEILING] = 0
        copy_feedback_state_i_to_device(ctx.cuda, ctx.buffers.d_feedback_state_i, feedback_state_i_host, 'cuMemcpyHtoD(feedback_state_i safe risk gate)')


def refresh_exact_feedback_state(ctx, feedback_state_i_host, *, frame_offset, exact_transition_logged):
    if not ctx.cfg.exact_limiter_active:
        return exact_transition_logged
    copy_feedback_state_i_from_device(ctx.cuda, feedback_state_i_host, ctx.buffers.d_feedback_state_i, 'cuMemcpyDtoH(feedback_state_i)')
    if feedback_state_i_host[FB_I_INPUT_MISSING] != 0:
        raise RuntimeError(f'exact limiter streaming input window missing at frame_offset={frame_offset}')
    return _log_exact_transition(
        feedback_state_i_host,
        frame_offset=frame_offset,
        exact_transition_logged=exact_transition_logged,
    )


def _log_exact_transition(feedback_state_i_host, *, frame_offset, exact_transition_logged):
    if exact_transition_logged or feedback_state_i_host[FB_I_ABOVE_THRESHOLD] == 0:
        return exact_transition_logged
    print(format_profile_stage('exact_feedback_transition', [
        ('out_frame', feedback_state_i_host[FB_I_OUT_FRAME]),
        ('input_window', feedback_state_i_host[FB_I_INPUT_WINDOW]),
        ('write_frame', feedback_state_i_host[FB_I_WRITE_FRAME]),
        ('frame_offset', frame_offset),
        ('limiter_maybe_above_ceiling', feedback_state_i_host[FB_I_LIMITER_MAYBE_ABOVE_CEILING]),
    ]), file=sys.stderr)
    return True
