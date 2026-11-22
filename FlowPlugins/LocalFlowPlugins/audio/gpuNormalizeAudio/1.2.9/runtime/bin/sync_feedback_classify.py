
def has_prelimiter_unsafe(ctx, first_window, last_window):
    window_end = min(ctx.cfg.input_shape.windows, last_window)
    if first_window >= window_end:
        return False
    return any(ctx.prelimiter_unsafe_flags[first_window:window_end])


def chunk_has_prelimiter_unsafe(ctx, *, frame_offset, this_frames):
    first_window = frame_offset // ctx.cfg.input_shape.frames_per_window
    last_window = (frame_offset + this_frames + ctx.cfg.input_shape.frames_per_window - 1) // ctx.cfg.input_shape.frames_per_window
    return has_prelimiter_unsafe(ctx, first_window, last_window)


def classify_exact_chunk(ctx, result, *, frame_offset, this_frames, exact_run_end_frame, exact_run_flag):
    cfg = ctx.cfg
    exact_chunk_unsafe = None
    if cfg.loudnorm_mode.exact_limiter_active and ctx.prelimiter_unsafe_flags is not None:
        exact_chunk_unsafe = chunk_has_prelimiter_unsafe(ctx, frame_offset=frame_offset, this_frames=this_frames)
        if exact_chunk_unsafe:
            result.exact_unsafe_chunks += 1
        else:
            result.exact_safe_chunks += 1

    skip_safe_fill_chunk = False
    if cfg.loudnorm_mode.exact_limiter_active and cfg.exact.exact_skip_safe_fill and exact_chunk_unsafe is False and exact_run_flag == 0:
        safe_remaining_after_chunk = max(0, exact_run_end_frame - (frame_offset + this_frames))
        if safe_remaining_after_chunk >= cfg.limiter.exact_skip_safe_fill_margin_frames:
            skip_safe_fill_chunk = True
            result.exact_skip_safe_fill_chunks += 1
    return exact_chunk_unsafe, skip_safe_fill_chunk
