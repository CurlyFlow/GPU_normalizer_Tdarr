import array
import ctypes

from cuda_driver import chk


FEEDBACK_STATE_I_WORDS = 32
FEEDBACK_STATE_I_BYTES = FEEDBACK_STATE_I_WORDS * 4
FEEDBACK_STATE_D_WORDS = 208
FEEDBACK_STATE_D_BYTES = FEEDBACK_STATE_D_WORDS * 8
FFMPEG_STATE_AUDIT_I_WORDS = 25
FFMPEG_STATE_AUDIT_D_WORDS = 38

FB_I_INITIALIZED = 0
FB_I_SHORT_INDEX = 1
FB_I_OUT_SHORT_INDEX = 2
FB_I_SHORT_COUNT = 3
FB_I_OUT_SHORT_COUNT = 4
FB_I_OUT_WINDOW_COUNT = 5
FB_I_DELTA_INDEX = 6
FB_I_ABOVE_THRESHOLD = 7
FB_I_OUT_FRAME = 8
FB_I_WRITE_FRAME = 9
FB_I_WRITE_INDEX = 10
FB_I_INPUT_WINDOW = 11
FB_I_FRAME_TYPE = 12
FB_I_LIMITER_STATE = 13
FB_I_PEAK_INDEX = 14
FB_I_ENV_INDEX = 15
FB_I_ENV_CNT = 16
FB_I_ATTACK_STATE = 17
FB_I_FIRST = 18
FB_I_FINAL_INITIALIZED = 19
FB_I_FINAL_SRC_OFFSET = 20
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

FEEDBACK_STATE_I_FIELDS = {
    'initialized': FB_I_INITIALIZED,
    'short_index': FB_I_SHORT_INDEX,
    'out_short_index': FB_I_OUT_SHORT_INDEX,
    'short_count': FB_I_SHORT_COUNT,
    'out_short_count': FB_I_OUT_SHORT_COUNT,
    'out_window_count': FB_I_OUT_WINDOW_COUNT,
    'delta_index': FB_I_DELTA_INDEX,
    'above_threshold': FB_I_ABOVE_THRESHOLD,
    'out_frame': FB_I_OUT_FRAME,
    'write_frame': FB_I_WRITE_FRAME,
    'write_index': FB_I_WRITE_INDEX,
    'input_window': FB_I_INPUT_WINDOW,
    'frame_type': FB_I_FRAME_TYPE,
    'limiter_state': FB_I_LIMITER_STATE,
    'peak_index': FB_I_PEAK_INDEX,
    'env_index': FB_I_ENV_INDEX,
    'env_cnt': FB_I_ENV_CNT,
    'attack_state': FB_I_ATTACK_STATE,
    'first': FB_I_FIRST,
    'final_initialized': FB_I_FINAL_INITIALIZED,
    'final_src_offset': FB_I_FINAL_SRC_OFFSET,
    'input_missing': FB_I_INPUT_MISSING,
    'profile_counts': FB_I_PROFILE_COUNTS,
    'limiter_maybe_above_ceiling': FB_I_LIMITER_MAYBE_ABOVE_CEILING,
    'prefilled_output': FB_I_PREFILLED_OUTPUT,
    'prefill_chunk_safe': FB_I_PREFILL_CHUNK_SAFE,
    'skip_safe_fill': FB_I_SKIP_SAFE_FILL,
    'skip_safe_feedback': FB_I_SKIP_SAFE_FEEDBACK,
    'force_safe_idle': FB_I_FORCE_SAFE_IDLE,
    'safe_feedback_window_accum': FB_I_SAFE_FEEDBACK_WINDOW_ACCUM,
    'safe_feedback_slot_accum': FB_I_SAFE_FEEDBACK_SLOT_ACCUM,
    'parallel_unsafe_feedback': FB_I_PARALLEL_UNSAFE_FEEDBACK,
}

FB_D_SHORT_RING = 0
FB_D_OUT_SHORT_RING = 30
FB_D_DELTA = 60
FB_D_OUT_STATES = 90
FB_D_OUT_STATE_SLOTS = 5
FB_D_OUT_STATE_VALUES = FB_D_OUT_STATE_SLOTS * 4
FB_D_OUT_STATE_BYTES = FB_D_OUT_STATE_VALUES * 8
FB_D_SHORT_SUM = 110
FB_D_OUT_SHORT_SUM = 111
FB_D_OUT_WINDOW_SUM = 112
FB_D_PREV_DELTA = 113
FB_D_GAIN_REDUCTION0 = 114
FB_D_GAIN_REDUCTION1 = 115
FB_D_COUNT_OUTPUT_FRAMES = 116
FB_D_COUNT_INPUT_READS = 117
FB_D_COUNT_INPUT_ZEROS = 118
FB_D_COUNT_LIMITER_WRITES = 119
FB_D_COUNT_LIMITER_RW_SCALES = 120
FB_D_COUNT_OUTPUT_WRITES = 121
FB_D_COUNT_FEEDBACK_IIR = 122
FB_D_COUNT_SHORT_RING_WRITES = 123
FB_D_COUNT_DETECT_CALLS = 124
FB_D_COUNT_DETECT_FRAMES = 125
FB_D_COUNT_DETECT_LOOKAHEAD = 126
FB_D_COUNT_PEAK_HITS = 127
FB_D_SOURCE_OUT_SHORT_RING0 = 128
FB_D_SOURCE_OUT_SHORT_RING1 = 158
FB_D_SOURCE_OUT_WINDOW_SUM0 = 188
FB_D_SOURCE_OUT_WINDOW_SUM1 = 189
FB_D_SOURCE_IN_STATE0 = 190
FB_D_SOURCE_IN_STATE1 = 194

FEEDBACK_STATE_D_FIELDS = {
    'short_sum': FB_D_SHORT_SUM,
    'out_short_sum': FB_D_OUT_SHORT_SUM,
    'out_window_sum': FB_D_OUT_WINDOW_SUM,
    'prev_delta': FB_D_PREV_DELTA,
    'gain_reduction0': FB_D_GAIN_REDUCTION0,
    'gain_reduction1': FB_D_GAIN_REDUCTION1,
    'source_out_window_sum0': FB_D_SOURCE_OUT_WINDOW_SUM0,
    'source_out_window_sum1': FB_D_SOURCE_OUT_WINDOW_SUM1,
}

FEEDBACK_PROFILE_COUNT_FIELDS = {
    'output_frames': FB_D_COUNT_OUTPUT_FRAMES,
    'input_reads': FB_D_COUNT_INPUT_READS,
    'input_zeros': FB_D_COUNT_INPUT_ZEROS,
    'limiter_writes': FB_D_COUNT_LIMITER_WRITES,
    'limiter_scale_rw': FB_D_COUNT_LIMITER_RW_SCALES,
    'output_writes': FB_D_COUNT_OUTPUT_WRITES,
    'feedback_iir': FB_D_COUNT_FEEDBACK_IIR,
    'short_ring_writes': FB_D_COUNT_SHORT_RING_WRITES,
    'detect_calls': FB_D_COUNT_DETECT_CALLS,
    'detect_frames': FB_D_COUNT_DETECT_FRAMES,
    'detect_lookahead': FB_D_COUNT_DETECT_LOOKAHEAD,
    'peak_hits': FB_D_COUNT_PEAK_HITS,
}



class FeedbackStateIView:
    def __init__(self, state):
        self.state = state

    def get(self, name):
        return self.state[FEEDBACK_STATE_I_FIELDS[name]]

    def set(self, name, value):
        self.state[FEEDBACK_STATE_I_FIELDS[name]] = int(value)

    def enabled(self, name):
        return self.get(name) != 0

    def set_bool(self, name, value):
        self.set(name, 1 if value else 0)


def feedback_state_i_view(state):
    return FeedbackStateIView(state)


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


def copy_feedback_state_d_from_device(cuda, state, d_feedback_state_d, label):
    chk(cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(state.buffer_info()[0]), d_feedback_state_d, FEEDBACK_STATE_D_BYTES), label)


def copy_feedback_out_states_to_device(cuda, d_feedback_state_d, out_states, label):
    dst = ctypes.c_void_p(d_feedback_state_d.value + (FB_D_OUT_STATES * 8))
    chk(cuda.cuMemcpyHtoD_v2(dst, ctypes.c_void_p(out_states.buffer_info()[0]), FB_D_OUT_STATE_BYTES), label)


def segmented_safe_feedback_status(args, *, exact_limiter_active, exact_segmented_safe_feedback, exact_prefill_output, exact_chunk_unsafe, frame_offset, exact_prefinal_frames, this_frames, frames_per_window, feedback_state_i_host):
    if not (exact_limiter_active and exact_segmented_safe_feedback and exact_prefill_output and exact_chunk_unsafe is False):
        return False, False
    state = feedback_state_i_view(feedback_state_i_host)
    is_candidate = (
        args.channels in (2, 6)
        and args.output_format == 'f64le'
        and frame_offset < exact_prefinal_frames
        and this_frames > 0
        and (frame_offset % frames_per_window) == 0
        and (this_frames % frames_per_window) == 0
        and state.enabled('initialized')
        and not state.enabled('first')
        and state.get('limiter_state') == 0
        and state.get('out_window_count') == 0
    )
    return is_candidate, not is_candidate


def parallel_unsafe_feedback_status(args, *, exact_parallel_unsafe_feedback, exact_chunk_unsafe, frame_offset, exact_prefinal_frames, this_frames, frames_per_window, feedback_state_i_host):
    if not (exact_parallel_unsafe_feedback and exact_chunk_unsafe is True):
        return False
    state = feedback_state_i_view(feedback_state_i_host)
    return (
        args.channels in (2, 6)
        and args.output_format == 'f64le'
        and frame_offset < exact_prefinal_frames
        and this_frames > 0
        and (frame_offset % frames_per_window) == 0
        and (this_frames % frames_per_window) == 0
        and state.enabled('initialized')
        and not state.enabled('first')
        and state.get('out_window_count') == 0
    )
