from __future__ import annotations

import ctypes

from cuda_driver import chk
from feedback_apply import FEEDBACK_STATE_D_WORDS, FEEDBACK_STATE_I_WORDS


class RuntimeBuffers:
    def __init__(self):
        self.d_in = ctypes.c_void_p()
        self.d_out = ctypes.c_void_p()
        self.d_apply_in_b = ctypes.c_void_p()
        self.d_apply_out_b = ctypes.c_void_p()
        self.d_sums = ctypes.c_void_p()
        self.d_channel_sums = ctypes.c_void_p()
        self.d_peaks = ctypes.c_void_p()
        self.d_gains = ctypes.c_void_p()
        self.d_gains_next = ctypes.c_void_p()
        self.d_limiter_buf = ctypes.c_void_p()
        self.d_limiter_prev = ctypes.c_void_p()
        self.d_feedback_state_i = ctypes.c_void_p()
        self.d_feedback_state_d = ctypes.c_void_p()
        self.d_feedback_hist = ctypes.c_void_p()
        self.d_safe_feedback_frames = ctypes.c_void_p()
        self.d_exact_sums_state_i = ctypes.c_void_p()
        self.d_exact_sums_state_d = ctypes.c_void_p()
        self.d_b = ctypes.c_void_p()
        self.d_a = ctypes.c_void_p()
        self.d_q_states = ctypes.c_void_p()
        self.d_start_states = ctypes.c_void_p()
        self.d_hist_energies = ctypes.c_void_p()
        self.d_hist_boundaries = ctypes.c_void_p()
        self.d_metrics = ctypes.c_void_p()
        self.d_source_short_ring = ctypes.c_void_p()
        self.d_source_exact_sums = ctypes.c_void_p()
        self.d_source_exact_audit_sums = ctypes.c_void_p()
        self.d_source_start_states = ctypes.c_void_p()
        self.d_source_energy = ctypes.c_void_p()
        self.d_source_block_sums = ctypes.c_void_p()

    def free_order(self):
        return [
            self.d_source_block_sums, self.d_source_energy, self.d_source_start_states,
            self.d_source_exact_audit_sums, self.d_source_exact_sums, self.d_source_short_ring,
            self.d_metrics, self.d_hist_boundaries, self.d_hist_energies,
            self.d_start_states, self.d_q_states, self.d_a, self.d_b,
            self.d_exact_sums_state_d, self.d_exact_sums_state_i,
            self.d_safe_feedback_frames, self.d_feedback_hist, self.d_feedback_state_d, self.d_feedback_state_i,
            self.d_limiter_prev, self.d_limiter_buf, self.d_gains_next,
            self.d_gains, self.d_peaks, self.d_sums, self.d_apply_out_b,
            self.d_apply_in_b, self.d_out, self.d_in,
        ]


def allocate_runtime_buffers(cuda, args, cfg):
    buffers = RuntimeBuffers()
    windows = cfg.windows
    chunk_bytes = cfg.chunk_bytes
    stats_chunk_bytes = cfg.stats_chunk_bytes
    apply_input_chunk_bytes = cfg.apply_input_chunk_bytes
    output_chunk_bytes = cfg.output_chunk_bytes
    chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_in), max(chunk_bytes, stats_chunk_bytes, apply_input_chunk_bytes)), 'cuMemAlloc(input)')
    chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_out), output_chunk_bytes), 'cuMemAlloc(output)')
    state_bytes = windows * args.channels * 4 * 8
    for ptr, size, label in [
        (buffers.d_sums, windows * 8, 'sums'),
        (buffers.d_channel_sums, windows * args.channels * 8, 'channel_sums'),
        (buffers.d_peaks, windows * 4, 'peaks'),
        (buffers.d_gains, windows * 4, 'gains'),
        (buffers.d_gains_next, windows * 4, 'gains_next'),
        (buffers.d_b, 5 * 8, 'filter_b'),
        (buffers.d_a, 5 * 8, 'filter_a'),
        (buffers.d_q_states, state_bytes, 'q_states'),
        (buffers.d_start_states, state_bytes, 'start_states'),
        (buffers.d_hist_energies, 1000 * 8, 'hist_energies'),
        (buffers.d_hist_boundaries, 1001 * 8, 'hist_boundaries'),
        (buffers.d_metrics, 3 * 4, 'metrics'),
    ]:
        chk(cuda.cuMemAlloc_v2(ctypes.byref(ptr), size), f'cuMemAlloc({label})')
    if cfg.exact_limiter_active:
        chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_limiter_buf), cfg.limiter_alloc_frames * args.channels * 8), 'cuMemAlloc(limiter_buf)')
        chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_limiter_prev), args.channels * 8), 'cuMemAlloc(limiter_prev)')
        chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_feedback_state_i), FEEDBACK_STATE_I_WORDS * 4), 'cuMemAlloc(feedback_state_i)')
        chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_feedback_state_d), FEEDBACK_STATE_D_WORDS * 8), 'cuMemAlloc(feedback_state_d)')
        chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_feedback_hist), 1000 * 4), 'cuMemAlloc(feedback_hist)')
        if cfg.exact_segmented_safe_feedback and (cfg.exact_safe_feedback_prefix_energy or not (cfg.exact_safe_feedback_window_accum or cfg.exact_safe_feedback_slot_accum)):
            output_frames = output_chunk_bytes // (args.channels * 8)
            chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_safe_feedback_frames), max(1, output_frames) * 5 * 8), 'cuMemAlloc(safe_feedback_frames)')
        chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_exact_sums_state_i), 8 * 4), 'cuMemAlloc(exact_sums_state_i)')
        chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_exact_sums_state_d), (args.channels * 4 + 1) * 8), 'cuMemAlloc(exact_sums_state_d)')
        if cfg.source_faithful_stereo and not cfg.source_exact_precompute:
            chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_source_short_ring), cfg.frames_per_window * 30 * args.channels * 8), 'cuMemAlloc(source_short_ring)')
        if cfg.source_exact_precompute:
            chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_source_exact_sums), max(1, windows) * 3 * 8), 'cuMemAlloc(source_exact_sums)')
            if cfg.source_sum_audit:
                chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_source_exact_audit_sums), max(1, windows) * 3 * 8), 'cuMemAlloc(source_exact_audit_sums)')
            if (not cfg.source_precompute_from_channel_sums) or cfg.source_channel_hist4_exact or cfg.source_channel_hist4_boundary:
                chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_source_start_states), state_bytes), 'cuMemAlloc(source_start_states)')
            if (not cfg.source_precompute_from_channel_sums) or cfg.source_channel_hist4_exact:
                chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_source_energy), apply_input_chunk_bytes), 'cuMemAlloc(source_energy)')
            if (not cfg.source_precompute_from_channel_sums) and cfg.source_block_sum_candidate:
                chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_source_block_sums), cfg.source_block_sum_bytes), 'cuMemAlloc(source_block_sums)')
    return buffers, state_bytes


def free_runtime_buffers(cuda, buffers):
    for ptr in buffers.free_order():
        if ptr.value:
            cuda.cuMemFree_v2(ptr)
