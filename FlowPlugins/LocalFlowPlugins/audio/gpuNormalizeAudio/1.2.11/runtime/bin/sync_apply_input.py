import ctypes
import time

from cuda_driver import chk
from feedback_apply import feedback_state_i_view


def copy_sync_input(ctx, result, copy_input_bytes):
    if copy_input_bytes <= 0:
        return
    t0 = time.perf_counter()
    chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_in, ctypes.c_void_p(ctx.host_io.host_in_ptr), copy_input_bytes), 'cuMemcpyHtoD(apply input)')
    copy_dt = time.perf_counter() - t0
    result.apply_h2d_time += copy_dt
    result.total_h2d_time += copy_dt


def safe_skip_chunk_bytes(ctx, state):
    cfg = ctx.cfg
    chunk_bytes = int(getattr(cfg.sizing, 'exact_safe_skip_chunk_bytes', 0) or 0)
    if chunk_bytes <= cfg.sizing.chunk_bytes:
        return None
    if not (
        cfg.loudnorm_mode.exact_limiter_active
        and cfg.exact.exact_sparse_chunks
        and cfg.exact.exact_parallel_skip_safe_feedback
        and cfg.exact.exact_skip_safe_feedback
        and not cfg.exact.exact_profile_counts
        and not cfg.exact.exact_use_prefilled_output
        and not cfg.source.source_exact_precompute
        and ctx.args.channels == 6
        and ctx.args.output_format == 'f64le'
        and state.frame_offset > 0
        and state.frame_offset < state.exact_prefinal_frames
        and (state.frame_offset % cfg.input_shape.frames_per_window) == 0
    ):
        return None
    first_window = state.frame_offset // cfg.input_shape.frames_per_window
    if ctx.prelimiter_unsafe_flags is None or first_window >= len(ctx.prelimiter_unsafe_flags):
        return None
    if ctx.prelimiter_unsafe_flags[first_window] != 0:
        return None
    feedback = feedback_state_i_view(state.feedback_state_i_host)
    if not (
        feedback.enabled('above_threshold')
        and not feedback.enabled('first')
        and feedback.get('out_window_count') == 0
        and not feedback.enabled('skip_safe_fill')
    ):
        return None
    return chunk_bytes
