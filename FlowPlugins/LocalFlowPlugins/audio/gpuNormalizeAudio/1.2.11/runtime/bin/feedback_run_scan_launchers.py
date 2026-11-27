import ctypes

from cuda_launch import launch_timed_kernel
from feedback_apply import feedback_state_i_view
from feedback_apply_kernel import launch_apply_kernel, record_safe_apply_kernel
import kernel_args


def launch_source_safe_run_scan_apply(ctx, result, apply_chunk, feedback_state_i_host, *, local_windows):
    cfg = ctx.cfg
    state = feedback_state_i_view(feedback_state_i_host)
    if not (
        cfg.exact.source_safe_run_scan_apply
        and cfg.source.source_exact_precompute
        and ctx.args.channels == 2
        and state.enabled('above_threshold')
        and state.get('out_window_count') == 0
    ):
        return False

    bindings = ctx.bindings
    out_frame_start = state.get('out_frame')
    write_frame_start = state.get('write_frame')
    lead_frames = write_frame_start - out_frame_start if write_frame_start >= out_frame_start else 0
    fill_gain_lead = (lead_frames + cfg.input_shape.frames_per_window - 1) // cfg.input_shape.frames_per_window
    fill_gain_count = fill_gain_lead + local_windows + 2

    local_windows_arg = ctypes.c_uint32(local_windows)
    fill_gain_lead_arg = ctypes.c_uint32(fill_gain_lead)
    fill_gain_count_arg = ctypes.c_uint32(fill_gain_count)
    source_precomputed_arg = ctypes.c_uint32(2)
    null_feedback_arg = ctypes.c_uint64(0)
    stitch_args = kernel_args.build_safe_feedback_stitch_args(
        bindings.feedback_state_i_arg,
        bindings.feedback_state_d_arg,
        bindings.feedback_hist_arg,
        bindings.out_arg,
        bindings.limiter_prev_arg,
        bindings.source_exact_sums_arg,
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
        source_precomputed_arg,
    )
    stitch_dt = launch_timed_kernel(ctx.cuda, 'source-safe-run-scan', ctx.kernels.safe_feedback_stitch_fn, stitch_args)

    fill_frames = apply_chunk.this_frames + lead_frames
    samples_arg = ctypes.c_uint32(fill_frames * ctx.args.channels)
    output_frames_arg = ctypes.c_uint32(apply_chunk.this_frames)
    output_frame_arg = ctypes.c_uint32(out_frame_start)
    write_frame_arg = ctypes.c_uint32(write_frame_start)
    fill_args = kernel_args.build_safe_feedback_fill_args(
        bindings.in_arg,
        bindings.out_arg,
        bindings.limiter_buf_arg,
        bindings.limiter_prev_arg,
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
    fill_dt = launch_apply_kernel(ctx, 'source-safe-run-fill', ctx.kernels.safe_feedback_fill_fn, fill_args, grid_x=fill_grid, block_x=256)
    kernel_dt = stitch_dt + fill_dt
    record_safe_apply_kernel(result, kernel_dt)
    result.segmented_safe_feedback_profile.record_prefix(0.0, fill_dt, stitch_dt, local_windows)
    return True


def launch_safe_run_scan_apply_6ch(ctx, result, apply_chunk, feedback_state_i_host, *, local_windows):
    cfg = ctx.cfg
    state = feedback_state_i_view(feedback_state_i_host)
    if not (
        cfg.exact.exact_safe_run_scan_apply_6ch
        and not cfg.source.source_exact_precompute
        and ctx.args.channels == 6
        and state.enabled('above_threshold')
        and state.get('limiter_maybe_above_ceiling') == 0
        and state.get('out_window_count') == 0
    ):
        return False
    if not _safe_run_scan_6ch_boundary_halo_ok(ctx, apply_chunk):
        return False

    bindings = ctx.bindings
    out_frame_start = state.get('out_frame')
    write_frame_start = state.get('write_frame')
    lead_frames = write_frame_start - out_frame_start if write_frame_start >= out_frame_start else 0
    fill_gain_lead = (lead_frames + cfg.input_shape.frames_per_window - 1) // cfg.input_shape.frames_per_window
    fill_gain_count = fill_gain_lead + local_windows + 2

    local_windows_arg = ctypes.c_uint32(local_windows)
    fill_gain_lead_arg = ctypes.c_uint32(fill_gain_lead)
    fill_gain_count_arg = ctypes.c_uint32(fill_gain_count)
    null_feedback_arg = ctypes.c_uint64(0)
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
        ctypes.c_uint32(0),
    )
    stitch_dt = launch_timed_kernel(ctx.cuda, 'safe-run-scan-6ch', ctx.kernels.safe_feedback_stitch_fn, stitch_args)

    fill_frames = apply_chunk.this_frames + lead_frames
    samples_arg = ctypes.c_uint32(fill_frames * ctx.args.channels)
    output_frames_arg = ctypes.c_uint32(apply_chunk.this_frames)
    output_frame_arg = ctypes.c_uint32(out_frame_start)
    write_frame_arg = ctypes.c_uint32(write_frame_start)
    fill_args = kernel_args.build_safe_feedback_fill_args(
        bindings.in_arg,
        bindings.out_arg,
        bindings.limiter_buf_arg,
        bindings.limiter_prev_arg,
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
    fill_dt = launch_apply_kernel(ctx, 'safe-run-fill-6ch', ctx.kernels.safe_feedback_fill_fn, fill_args, grid_x=fill_grid, block_x=256)
    kernel_dt = stitch_dt + fill_dt
    record_safe_apply_kernel(result, kernel_dt)
    result.segmented_safe_feedback_profile.record_prefix(0.0, fill_dt, stitch_dt, local_windows)
    return True


def _safe_run_scan_6ch_boundary_halo_ok(ctx, apply_chunk):
    halo_windows = int(getattr(ctx.cfg.exact, 'exact_safe_run_scan_apply_6ch_boundary_halo_windows', 0) or 0)
    if halo_windows <= 0:
        return True
    flags = ctx.prelimiter_unsafe_flags
    if flags is None or ctx.cfg.input_shape.frames_per_window <= 0:
        return False
    frame_offset = int(apply_chunk.input_base_arg.value if apply_chunk.input_base_arg is not None else 0)
    this_frames = int(apply_chunk.this_frames)
    if frame_offset % ctx.cfg.input_shape.frames_per_window != 0 or this_frames % ctx.cfg.input_shape.frames_per_window != 0:
        return False
    first_window = frame_offset // ctx.cfg.input_shape.frames_per_window
    chunk_end_window = (frame_offset + this_frames) // ctx.cfg.input_shape.frames_per_window
    if first_window < 0 or first_window >= len(flags) or chunk_end_window > len(flags):
        return False
    if flags[first_window] != 0:
        return False
    run_start_window = first_window
    while run_start_window > 0 and flags[run_start_window - 1] == 0:
        run_start_window -= 1
    run_end_window = first_window + 1
    while run_end_window < len(flags) and flags[run_end_window] == 0:
        run_end_window += 1
    if chunk_end_window > run_end_window:
        return False
    return first_window - run_start_window >= halo_windows and run_end_window - chunk_end_window >= halo_windows
