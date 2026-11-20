from feedback_apply_args import safe_feedback_apply6_args, safe_skip_output_sums_active
from feedback_apply import feedback_state_i_view
from feedback_apply_kernel import launch_apply_kernel, record_safe_apply_kernel, record_unsafe_apply_kernel
from feedback_modes import can_parallel_skip_safe_feedback


def launch_parallel_skip_safe_feedback(ctx, result, apply_chunk, feedback_state_i_host, *, local_windows):
    cfg = ctx.cfg
    if safe_skip_output_sums_active(ctx) or not can_parallel_skip_safe_feedback(ctx, apply_chunk, feedback_state_i_host):
        return False
    state = feedback_state_i_view(feedback_state_i_host)
    frame_specialized = (
        (getattr(cfg.exact, 'exact_safe_skip_apply_frame_kernel', False) or getattr(cfg.exact, 'exact_skip_apply_rolling_ring_6ch', False))
        and state.enabled('above_threshold')
        and ctx.args.channels in (2, 6)
        and ctx.args.output_format == 'f64le'
    )
    skip_lookahead_scan_6ch = (
        ctx.args.channels == 6
        and state.enabled('above_threshold')
        and state.get('limiter_maybe_above_ceiling') == 0
        and state.get('limiter_state') == 0
    )
    skip_apply_args = safe_feedback_apply6_args(ctx, apply_chunk, frame_specialized=frame_specialized, skip_lookahead_scan_6ch=skip_lookahead_scan_6ch)
    label = 'safe-feedback-skip-frame6' if frame_specialized else 'safe-feedback-skip-parallel6'
    apply_dt = launch_apply_kernel(ctx, label, ctx.kernels.safe_feedback_skip_apply_fn, skip_apply_args, block_x=256)
    record_safe_apply_kernel(result, apply_dt)
    result.segmented_safe_feedback_profile.record_parallel_skip(apply_dt, local_windows)
    return True


def launch_safe_feedback_apply(ctx, result, apply_chunk, *, local_windows):
    safe_apply_args = safe_feedback_apply6_args(ctx, apply_chunk)
    apply_dt = launch_apply_kernel(ctx, 'safe-feedback-apply6', ctx.kernels.safe_feedback_apply_fn, safe_apply_args, block_x=ctx.args.channels)
    record_safe_apply_kernel(result, apply_dt)
    result.segmented_safe_feedback_profile.record_apply(apply_dt, local_windows)


def launch_parallel_unsafe_feedback(ctx, result, apply_chunk, feedback_state_i_host, *, local_windows):
    cfg = ctx.cfg
    unsafe_apply_args = safe_feedback_apply6_args(ctx, apply_chunk)
    unsafe_kernel = ctx.kernels.safe_feedback_apply_fn
    unsafe_label = 'unsafe-feedback-apply6'
    unsafe_block_x = ctx.args.channels
    output_sums_active = safe_skip_output_sums_active(ctx)
    if cfg.exact.source_unsafe_skip_kernel and not output_sums_active and cfg.source.source_exact_precompute and ctx.args.channels == 2:
        unsafe_kernel = ctx.kernels.safe_feedback_skip_apply_fn
        unsafe_label = 'unsafe-feedback-skip-parallel6'
        unsafe_block_x = 256
    elif cfg.exact.exact_unsafe_skip_kernel_6ch and not output_sums_active and ctx.args.channels == 6 and feedback_state_i_view(feedback_state_i_host).enabled('above_threshold'):
        unsafe_kernel = ctx.kernels.safe_feedback_skip_apply_fn
        unsafe_label = 'unsafe-feedback-skip-parallel6ch'
        unsafe_block_x = 256
    apply_dt = launch_apply_kernel(ctx, unsafe_label, unsafe_kernel, unsafe_apply_args, block_x=unsafe_block_x)
    record_unsafe_apply_kernel(result, apply_dt)
    result.segmented_safe_feedback_profile.record_unsafe_apply(apply_dt, local_windows)


def launch_direct_apply_kernel(ctx, result, apply_chunk, *, exact_chunk_unsafe):
    cfg = ctx.cfg
    apply_dt = launch_apply_kernel(ctx, 'apply', ctx.kernels.apply_fn, apply_chunk.apply_args, grid_x=apply_chunk.grid_samples, block_x=1 if cfg.loudnorm_mode.exact_limiter_active else 256, check_label=f'cuLaunchKernel({apply_chunk.kernel_label})')
    result.apply_kernel_time += apply_dt
    if cfg.loudnorm_mode.exact_limiter_active and exact_chunk_unsafe is not None:
        if exact_chunk_unsafe:
            result.exact_unsafe_kernel_time += apply_dt
            result.exact_unsafe_apply_kernel_time += apply_dt
        else:
            result.exact_safe_kernel_time += apply_dt
            result.exact_safe_apply_kernel_time += apply_dt
