from __future__ import annotations

import ctypes
from dataclasses import dataclass

from cuda_driver import chk
from feedback_apply import FEEDBACK_STATE_D_WORDS, FEEDBACK_STATE_I_WORDS


@dataclass(frozen=True)
class BufferAllocation:
    attr: str
    size: int
    label: str


class RuntimeBuffers:
    def __init__(self):
        self.d_in = ctypes.c_void_p()
        self.d_stats_in_b = ctypes.c_void_p()
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
        self.d_checkpoint_states = ctypes.c_void_p()
        self.d_hist_energies = ctypes.c_void_p()
        self.d_hist_boundaries = ctypes.c_void_p()
        self.d_metrics = ctypes.c_void_p()
        self.d_source_short_ring = ctypes.c_void_p()
        self.d_source_exact_sums = ctypes.c_void_p()
        self.d_source_exact_audit_sums = ctypes.c_void_p()
        self.d_source_start_states = ctypes.c_void_p()
        self.d_source_energy = ctypes.c_void_p()
        self.d_source_correction_flags = ctypes.c_void_p()
        self.d_source_block_sums = ctypes.c_void_p()
        self.d_input_metric_audit_sums = ctypes.c_void_p()

    def free_order(self):
        return [
            self.d_input_metric_audit_sums,
            self.d_source_block_sums, self.d_source_correction_flags, self.d_source_energy, self.d_source_start_states,
            self.d_source_exact_audit_sums, self.d_source_exact_sums, self.d_source_short_ring,
            self.d_metrics, self.d_hist_boundaries, self.d_hist_energies,
            self.d_checkpoint_states, self.d_start_states, self.d_q_states, self.d_a, self.d_b,
            self.d_exact_sums_state_d, self.d_exact_sums_state_i,
            self.d_safe_feedback_frames, self.d_feedback_hist, self.d_feedback_state_d, self.d_feedback_state_i,
            self.d_limiter_prev, self.d_limiter_buf, self.d_gains_next,
            self.d_gains, self.d_peaks, self.d_sums, self.d_apply_out_b,
            self.d_apply_in_b, self.d_out, self.d_stats_in_b, self.d_in,
        ]


def allocate_runtime_buffers(cuda, args, cfg):
    buffers = RuntimeBuffers()
    allocations, state_bytes = runtime_buffer_allocation_plan(args, cfg)
    for allocation in allocations:
        ptr = getattr(buffers, allocation.attr)
        chk(cuda.cuMemAlloc_v2(ctypes.byref(ptr), allocation.size), f'cuMemAlloc({allocation.label})')
    return buffers, state_bytes


def runtime_buffer_allocation_plan(args, cfg):
    windows = cfg.windows
    chunk_bytes = cfg.chunk_bytes
    stats_chunk_bytes = cfg.stats_chunk_bytes
    apply_input_chunk_bytes = cfg.apply_input_chunk_bytes
    output_chunk_bytes = cfg.output_chunk_bytes
    state_bytes = windows * args.channels * 4 * 8
    allocations = [
        BufferAllocation('d_in', max(chunk_bytes, stats_chunk_bytes, apply_input_chunk_bytes), 'input'),
        BufferAllocation('d_stats_in_b', stats_chunk_bytes, 'stats input b'),
        BufferAllocation('d_out', output_chunk_bytes, 'output'),
        BufferAllocation('d_sums', windows * 8, 'sums'),
        BufferAllocation('d_channel_sums', windows * args.channels * 8, 'channel_sums'),
        BufferAllocation('d_peaks', windows * 4, 'peaks'),
        BufferAllocation('d_gains', windows * 4, 'gains'),
        BufferAllocation('d_gains_next', windows * 4, 'gains_next'),
        BufferAllocation('d_b', 5 * 8, 'filter_b'),
        BufferAllocation('d_a', 5 * 8, 'filter_a'),
        BufferAllocation('d_q_states', state_bytes, 'q_states'),
        BufferAllocation('d_start_states', state_bytes, 'start_states'),
        BufferAllocation('d_hist_energies', 1000 * 8, 'hist_energies'),
        BufferAllocation('d_hist_boundaries', 1001 * 8, 'hist_boundaries'),
        BufferAllocation('d_metrics', 3 * 4, 'metrics'),
    ]
    if getattr(cfg, 'encode_pipe_f32', False):
        allocations.append(BufferAllocation('d_apply_out_b', max(1, output_chunk_bytes // 2), 'encode pipe f32 output'))
    if cfg.exact_limiter_active:
        if getattr(cfg, 'exact_channel_stats_checkpoint_replay', False):
            allocations.append(BufferAllocation('d_checkpoint_states', state_bytes, 'checkpoint_states'))
        allocations.extend([
            BufferAllocation('d_limiter_buf', cfg.limiter_alloc_frames * args.channels * 8, 'limiter_buf'),
            BufferAllocation('d_limiter_prev', args.channels * 8, 'limiter_prev'),
            BufferAllocation('d_feedback_state_i', FEEDBACK_STATE_I_WORDS * 4, 'feedback_state_i'),
            BufferAllocation('d_feedback_state_d', FEEDBACK_STATE_D_WORDS * 8, 'feedback_state_d'),
            BufferAllocation('d_feedback_hist', 1000 * 4, 'feedback_hist'),
        ])
        if cfg.exact_segmented_safe_feedback and (cfg.exact_safe_feedback_prefix_energy or not (cfg.exact_safe_feedback_window_accum or cfg.exact_safe_feedback_slot_accum)):
            output_frames = output_chunk_bytes // (args.channels * 8)
            allocations.append(BufferAllocation('d_safe_feedback_frames', max(1, output_frames) * 5 * 8, 'safe_feedback_frames'))
        allocations.extend([
            BufferAllocation('d_exact_sums_state_i', 8 * 4, 'exact_sums_state_i'),
            BufferAllocation('d_exact_sums_state_d', (args.channels * 4 + 1) * 8, 'exact_sums_state_d'),
        ])
        if cfg.source_faithful_stereo and not cfg.source_exact_precompute:
            allocations.append(BufferAllocation('d_source_short_ring', cfg.frames_per_window * 30 * args.channels * 8, 'source_short_ring'))
        if cfg.source_exact_precompute:
            allocations.append(BufferAllocation('d_source_exact_sums', max(1, windows) * 3 * 8, 'source_exact_sums'))
            lean_cache_input = getattr(cfg, 'cache_input_lean_source', False)
            if (not lean_cache_input) and cfg.source_sum_audit:
                allocations.append(BufferAllocation('d_source_exact_audit_sums', max(1, windows) * 3 * 8, 'source_exact_audit_sums'))
            source_state_needed = (
                (not cfg.source_precompute_from_channel_sums)
                or cfg.source_channel_hist4_exact
                or cfg.source_channel_hist4_boundary
                or cfg.source_channel_short_exact
                or cfg.source_channel_short_boundary
                or getattr(cfg, 'source_channel_short_raw_boundary', False)
            )
            if (not lean_cache_input) and source_state_needed:
                allocations.append(BufferAllocation('d_source_start_states', state_bytes, 'source_start_states'))
            source_energy_needed = (
                (not cfg.source_precompute_from_channel_sums)
                or cfg.source_channel_hist4_exact
                or cfg.source_channel_short_exact
                or cfg.source_channel_short_boundary
            )
            if (not lean_cache_input) and source_energy_needed:
                allocations.append(BufferAllocation('d_source_energy', apply_input_chunk_bytes, 'source_energy'))
            if (not lean_cache_input) and getattr(cfg, 'source_channel_short_raw_boundary', False):
                allocations.append(BufferAllocation('d_source_correction_flags', max(1, windows) * 4, 'source_correction_flags'))
            if (not lean_cache_input) and (not cfg.source_precompute_from_channel_sums) and cfg.source_block_sum_candidate:
                allocations.append(BufferAllocation('d_source_block_sums', cfg.source_block_sum_bytes, 'source_block_sums'))
        if cfg.audit_ffmpeg_input_metrics or cfg.emit_first_pass_json:
            audit_windows = max(1, ((cfg.audit_input_replay_frames + cfg.frames_per_window - 1) // cfg.frames_per_window) + 1)
            allocations.append(BufferAllocation('d_input_metric_audit_sums', audit_windows * 8, 'input_metric_audit_sums'))
    return allocations, state_bytes


def free_runtime_buffers(cuda, buffers):
    for ptr in buffers.free_order():
        if ptr.value:
            cuda.cuMemFree_v2(ptr)
