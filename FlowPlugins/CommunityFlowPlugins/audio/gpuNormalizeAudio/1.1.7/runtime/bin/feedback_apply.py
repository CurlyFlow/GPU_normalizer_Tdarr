from __future__ import annotations

import array
import ctypes

from cuda_driver import chk


FEEDBACK_STATE_I_WORDS = 32
FEEDBACK_STATE_I_BYTES = FEEDBACK_STATE_I_WORDS * 4

FB_I_INITIALIZED = 0
FB_I_OUT_WINDOW_COUNT = 5
FB_I_ABOVE_THRESHOLD = 7
FB_I_OUT_FRAME = 8
FB_I_WRITE_FRAME = 9
FB_I_INPUT_WINDOW = 11
FB_I_LIMITER_STATE = 13
FB_I_FIRST = 18
FB_I_INPUT_MISSING = 21
FB_I_PROFILE_COUNTS = 22
FB_I_LIMITER_MAYBE_ABOVE_CEILING = 23
FB_I_PREFILLED_OUTPUT = 24
FB_I_PREFILL_CHUNK_SAFE = 25
FB_I_SKIP_SAFE_FILL = 26
FB_I_SKIP_SAFE_FEEDBACK = 27
FB_I_FORCE_SAFE_IDLE = 28
FB_I_SAFE_FEEDBACK_WINDOW_ACCUM = 29
FB_I_SAFE_FEEDBACK_SLOT_ACCUM = 30
FB_I_PARALLEL_UNSAFE_FEEDBACK = 31


def new_feedback_state_i(*, profile_counts=False, prefilled_output=False):
    state = array.array('I', [0]) * FEEDBACK_STATE_I_WORDS
    if profile_counts:
        state[FB_I_PROFILE_COUNTS] = 1
    if prefilled_output:
        state[FB_I_PREFILLED_OUTPUT] = 1
    return state


def copy_feedback_state_i_to_device(cuda, d_feedback_state_i, state, label):
    chk(cuda.cuMemcpyHtoD_v2(d_feedback_state_i, ctypes.c_void_p(state.buffer_info()[0]), FEEDBACK_STATE_I_BYTES), label)


def copy_feedback_state_i_from_device(cuda, state, d_feedback_state_i, label):
    chk(cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(state.buffer_info()[0]), d_feedback_state_i, FEEDBACK_STATE_I_BYTES), label)


def segmented_safe_feedback_status(args, *, exact_limiter_active, exact_segmented_safe_feedback, exact_prefill_output, exact_chunk_unsafe, frame_offset, exact_prefinal_frames, this_frames, frames_per_window, feedback_state_i_host):
    if not (exact_limiter_active and exact_segmented_safe_feedback and exact_prefill_output and exact_chunk_unsafe is False):
        return False, False
    is_candidate = (
        args.channels == 6
        and args.output_format == 'f64le'
        and frame_offset < exact_prefinal_frames
        and this_frames > 0
        and (frame_offset % frames_per_window) == 0
        and (this_frames % frames_per_window) == 0
        and feedback_state_i_host[FB_I_INITIALIZED] != 0
        and feedback_state_i_host[FB_I_FIRST] == 0
        and feedback_state_i_host[FB_I_LIMITER_STATE] == 0
        and feedback_state_i_host[FB_I_OUT_WINDOW_COUNT] == 0
    )
    return is_candidate, not is_candidate


def parallel_unsafe_feedback_status(args, *, exact_parallel_unsafe_feedback, exact_chunk_unsafe, frame_offset, exact_prefinal_frames, this_frames, frames_per_window, feedback_state_i_host):
    if not (exact_parallel_unsafe_feedback and exact_chunk_unsafe is True):
        return False
    return (
        args.channels == 6
        and args.output_format == 'f64le'
        and frame_offset < exact_prefinal_frames
        and this_frames > 0
        and (frame_offset % frames_per_window) == 0
        and (this_frames % frames_per_window) == 0
        and feedback_state_i_host[FB_I_INITIALIZED] != 0
        and feedback_state_i_host[FB_I_FIRST] == 0
        and feedback_state_i_host[FB_I_OUT_WINDOW_COUNT] == 0
    )
