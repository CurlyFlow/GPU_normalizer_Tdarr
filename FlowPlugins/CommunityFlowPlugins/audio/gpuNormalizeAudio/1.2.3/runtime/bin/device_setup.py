from __future__ import annotations

import array
import ctypes
from dataclasses import dataclass
import os

from cuda_driver import alloc_pinned_host_buffer, chk, has_async_apply_api, load_cuda, load_module
from runtime_env import env_flag
from feedback_apply import FEEDBACK_STATE_D_WORDS, FEEDBACK_STATE_I_WORDS, copy_feedback_state_i_to_device, new_feedback_state_i
from loudnorm_math import db_to_amp, frame_size, histogram_tables


@dataclass
class CudaSession:
    cuda: object
    ctx: ctypes.c_void_p
    module: ctypes.c_void_p
    gpu_name: str


def open_cuda_session(args):
    cuda = load_cuda()
    chk(cuda.cuInit(0), 'cuInit')
    device = ctypes.c_int()
    chk(cuda.cuDeviceGet(ctypes.byref(device), 0), 'cuDeviceGet')
    name = ctypes.create_string_buffer(128)
    chk(cuda.cuDeviceGetName(name, 128, device), 'cuDeviceGetName')
    ctx = ctypes.c_void_p()
    chk(cuda.cuCtxCreate_v2(ctypes.byref(ctx), 0, device), 'cuCtxCreate')
    if not os.path.exists(args.ptx_path):
        raise RuntimeError(f'Missing CUDA PTX file: {args.ptx_path}')
    ptx_text = open(args.ptx_path, 'r', encoding='utf-8').read()
    module = load_module(cuda, ptx_text)
    return CudaSession(cuda=cuda, ctx=ctx, module=module, gpu_name=name.value.decode())


def close_cuda_session(session):
    try:
        session.cuda.cuModuleUnload(session.module)
    finally:
        session.cuda.cuCtxDestroy_v2(session.ctx)


@dataclass
class HostIoBuffers:
    host_in: object
    host_out: object
    host_in_ptr: int
    host_out_ptr: int
    pinned_ptrs: tuple[ctypes.c_void_p, ...] = ()
    pinned_raws: tuple[object, ...] = ()
    pinned: int = 0


def create_host_io_buffers(cuda, cfg):
    chunk_bytes = cfg.chunk_bytes
    stats_chunk_bytes = cfg.stats_chunk_bytes
    apply_input_chunk_bytes = cfg.apply_input_chunk_bytes
    output_chunk_bytes = cfg.output_chunk_bytes
    input_bytes = max(chunk_bytes, stats_chunk_bytes, apply_input_chunk_bytes)
    pinned_requested = env_flag('LOUDNORM_GPU_PINNED_SYNC_IO')
    if pinned_requested and has_async_apply_api(cuda):
        try:
            in_ptr, in_raw, host_in = alloc_pinned_host_buffer(cuda, input_bytes, 'sync host input')
            out_ptr, out_raw, host_out = alloc_pinned_host_buffer(cuda, output_chunk_bytes, 'sync host output')
            return HostIoBuffers(
                host_in=host_in,
                host_out=host_out,
                host_in_ptr=in_ptr.value,
                host_out_ptr=out_ptr.value,
                pinned_ptrs=(in_ptr, out_ptr),
                pinned_raws=(in_raw, out_raw),
                pinned=1,
            )
        except Exception:
            pass
    host_in = bytearray(input_bytes)
    host_out = bytearray(output_chunk_bytes)
    return HostIoBuffers(
        host_in=host_in,
        host_out=host_out,
        host_in_ptr=ctypes.addressof(ctypes.c_char.from_buffer(host_in)),
        host_out_ptr=ctypes.addressof(ctypes.c_char.from_buffer(host_out)),
    )


def free_host_io_buffers(cuda, host_io):
    for ptr in getattr(host_io, 'pinned_ptrs', ()):
        if ptr.value:
            cuda.cuMemFreeHost(ptr)
            ptr.value = None


def initialize_runtime_buffers(cuda, args, buffers, *, cfg, state_bytes, b_coeffs, a_coeffs):
    windows = cfg.windows
    stats_cache_only_slim = getattr(cfg, 'stats_cache_only_slim', False)
    cache_input_setup_slim = getattr(cfg, 'cache_input_setup_slim', False)
    if not cache_input_setup_slim:
        chk(cuda.cuMemsetD32_v2(buffers.d_sums, 0, windows * 2), 'cuMemsetD32(sums)')
    chk(cuda.cuMemsetD32_v2(buffers.d_channel_sums, 0, windows * args.channels * 2), 'cuMemsetD32(channel_sums)')
    if not cache_input_setup_slim:
        chk(cuda.cuMemsetD32_v2(buffers.d_peaks, 0, windows), 'cuMemsetD32(peaks)')
    chk(cuda.cuMemsetD32_v2(buffers.d_q_states, 0, state_bytes // 4), 'cuMemsetD32(q_states)')
    if not cache_input_setup_slim:
        chk(cuda.cuMemsetD32_v2(buffers.d_start_states, 0, state_bytes // 4), 'cuMemsetD32(start_states)')
    if cfg.exact_limiter_active:
        if not stats_cache_only_slim:
            chk(cuda.cuMemsetD32_v2(buffers.d_limiter_buf, 0, cfg.limiter_alloc_frames * args.channels * 2), 'cuMemsetD32(limiter_buf)')
            chk(cuda.cuMemsetD32_v2(buffers.d_limiter_prev, 0, args.channels * 2), 'cuMemsetD32(limiter_prev)')
            chk(cuda.cuMemsetD32_v2(buffers.d_feedback_state_i, 0, FEEDBACK_STATE_I_WORDS), 'cuMemsetD32(feedback_state_i)')
            chk(cuda.cuMemsetD32_v2(buffers.d_feedback_state_d, 0, FEEDBACK_STATE_D_WORDS * 2), 'cuMemsetD32(feedback_state_d)')
            chk(cuda.cuMemsetD32_v2(buffers.d_feedback_hist, 0, 1000), 'cuMemsetD32(feedback_hist)')
        chk(cuda.cuMemsetD32_v2(buffers.d_exact_sums_state_i, 0, 8), 'cuMemsetD32(exact_sums_state_i)')
        chk(cuda.cuMemsetD32_v2(buffers.d_exact_sums_state_d, 0, (args.channels * 4 + 1) * 2), 'cuMemsetD32(exact_sums_state_d)')
        if buffers.d_source_short_ring.value and not stats_cache_only_slim:
            chk(cuda.cuMemsetD32_v2(buffers.d_source_short_ring, 0, cfg.frames_per_window * 30 * args.channels * 2), 'cuMemsetD32(source_short_ring)')
        if buffers.d_source_exact_sums.value and not getattr(cfg, 'cache_input_lean_source', False) and not cache_input_setup_slim:
            chk(cuda.cuMemsetD32_v2(buffers.d_source_exact_sums, 0, max(1, windows) * 3 * 2), 'cuMemsetD32(source_exact_sums)')
        if buffers.d_source_exact_audit_sums.value:
            chk(cuda.cuMemsetD32_v2(buffers.d_source_exact_audit_sums, 0, max(1, windows) * 3 * 2), 'cuMemsetD32(source_exact_audit_sums)')
        if buffers.d_source_start_states.value:
            chk(cuda.cuMemsetD32_v2(buffers.d_source_start_states, 0, state_bytes // 4), 'cuMemsetD32(source_start_states)')
        if buffers.d_source_energy.value:
            chk(cuda.cuMemsetD32_v2(buffers.d_source_energy, 0, cfg.apply_input_chunk_bytes // 4), 'cuMemsetD32(source_energy)')
        if buffers.d_source_block_sums.value:
            chk(cuda.cuMemsetD32_v2(buffers.d_source_block_sums, 0, cfg.source_block_sum_bytes // 4), 'cuMemsetD32(source_block_sums)')
        if buffers.d_input_metric_audit_sums.value:
            audit_windows = max(1, (cfg.audit_input_replay_frames + cfg.frames_per_window - 1) // cfg.frames_per_window)
            chk(cuda.cuMemsetD32_v2(buffers.d_input_metric_audit_sums, 0, audit_windows * 2), 'cuMemsetD32(input_metric_audit_sums)')
        if (not stats_cache_only_slim) and (cfg.exact_profile_counts or cfg.exact_use_prefilled_output):
            feedback_state_i_init = new_feedback_state_i(profile_counts=cfg.exact_profile_counts, prefilled_output=cfg.exact_use_prefilled_output)
            copy_feedback_state_i_to_device(cuda, buffers.d_feedback_state_i, feedback_state_i_init, 'cuMemcpyHtoD(feedback_state_i profile)')

    b_arr = array.array('d', b_coeffs)
    a_arr = array.array('d', a_coeffs)
    hist_energies_values, hist_boundaries_values = histogram_tables()
    hist_energies = array.array('d', hist_energies_values)
    hist_boundaries = array.array('d', hist_boundaries_values)
    chk(cuda.cuMemcpyHtoD_v2(buffers.d_b, ctypes.c_void_p(b_arr.buffer_info()[0]), 5 * 8), 'cuMemcpyHtoD(filter_b)')
    chk(cuda.cuMemcpyHtoD_v2(buffers.d_a, ctypes.c_void_p(a_arr.buffer_info()[0]), 5 * 8), 'cuMemcpyHtoD(filter_a)')
    chk(cuda.cuMemcpyHtoD_v2(buffers.d_hist_energies, ctypes.c_void_p(hist_energies.buffer_info()[0]), 1000 * 8), 'cuMemcpyHtoD(hist_energies)')
    chk(cuda.cuMemcpyHtoD_v2(buffers.d_hist_boundaries, ctypes.c_void_p(hist_boundaries.buffer_info()[0]), 1001 * 8), 'cuMemcpyHtoD(hist_boundaries)')


@dataclass
class KernelArgBindings:
    in_arg: ctypes.c_uint64
    out_arg: ctypes.c_uint64
    sums_arg: ctypes.c_uint64
    channel_sums_arg: ctypes.c_uint64
    peaks_arg: ctypes.c_uint64
    gains_arg: ctypes.c_uint64
    gains_next_arg: ctypes.c_uint64
    limiter_buf_arg: ctypes.c_uint64
    limiter_prev_arg: ctypes.c_uint64
    feedback_state_i_arg: ctypes.c_uint64
    feedback_state_d_arg: ctypes.c_uint64
    feedback_hist_arg: ctypes.c_uint64
    safe_feedback_frames_arg: ctypes.c_uint64
    exact_sums_state_i_arg: ctypes.c_uint64
    exact_sums_state_d_arg: ctypes.c_uint64
    b_arg: ctypes.c_uint64
    a_arg: ctypes.c_uint64
    q_states_arg: ctypes.c_uint64
    start_states_arg: ctypes.c_uint64
    hist_energies_arg: ctypes.c_uint64
    hist_boundaries_arg: ctypes.c_uint64
    metrics_arg: ctypes.c_uint64
    source_short_ring_arg: ctypes.c_uint64
    source_exact_sums_arg: ctypes.c_uint64
    source_exact_audit_sums_arg: ctypes.c_uint64
    source_start_states_arg: ctypes.c_uint64
    source_energy_arg: ctypes.c_uint64
    source_block_sums_arg: ctypes.c_uint64
    channels_arg: ctypes.c_uint32
    frame_window_arg: ctypes.c_uint32
    windows_arg: ctypes.c_uint32
    target_i_arg: ctypes.c_float
    target_lra_arg: ctypes.c_float
    target_tp_arg: ctypes.c_float
    measured_i_arg: ctypes.c_float
    measured_thresh_arg: ctypes.c_float
    offset_db_arg: ctypes.c_float
    linear_mode_arg: ctypes.c_uint32
    ceiling_arg: ctypes.c_float
    exact_limiter_ceiling_arg: ctypes.c_double
    exact_target_i_arg: ctypes.c_double
    exact_target_lra_arg: ctypes.c_double
    exact_measured_i_arg: ctypes.c_double
    exact_measured_thresh_arg: ctypes.c_double
    exact_offset_amp_arg: ctypes.c_double
    limiter_lookahead_arg: ctypes.c_uint32
    total_frames_arg: ctypes.c_uint32
    gain_timing_offset_arg: ctypes.c_uint32
    attack_length_arg: ctypes.c_uint32
    release_length_arg: ctypes.c_uint32

    def as_tuple(self):
        return (
            self.in_arg, self.out_arg, self.sums_arg, self.channel_sums_arg,
            self.peaks_arg, self.gains_arg, self.gains_next_arg, self.limiter_buf_arg,
            self.limiter_prev_arg, self.feedback_state_i_arg, self.feedback_state_d_arg,
            self.feedback_hist_arg, self.safe_feedback_frames_arg, self.exact_sums_state_i_arg,
            self.exact_sums_state_d_arg, self.b_arg, self.a_arg, self.q_states_arg,
            self.start_states_arg, self.hist_energies_arg, self.hist_boundaries_arg,
            self.metrics_arg, self.source_short_ring_arg, self.source_exact_sums_arg,
            self.source_exact_audit_sums_arg, self.source_start_states_arg, self.source_energy_arg,
            self.source_block_sums_arg, self.channels_arg, self.frame_window_arg, self.windows_arg,
            self.target_i_arg, self.target_lra_arg, self.target_tp_arg, self.measured_i_arg,
            self.measured_thresh_arg, self.offset_db_arg, self.linear_mode_arg, self.ceiling_arg,
            self.exact_limiter_ceiling_arg, self.exact_target_i_arg, self.exact_target_lra_arg,
            self.exact_measured_i_arg, self.exact_measured_thresh_arg, self.exact_offset_amp_arg,
            self.limiter_lookahead_arg, self.total_frames_arg, self.gain_timing_offset_arg,
            self.attack_length_arg, self.release_length_arg,
        )

    def update_frame_totals(self, *, total_frames, windows):
        self.windows_arg = ctypes.c_uint32(windows)
        self.total_frames_arg = ctypes.c_uint32(total_frames)


def build_kernel_arg_bindings(args, buffers, cfg):
    return KernelArgBindings(
        in_arg=ctypes.c_uint64(buffers.d_in.value),
        out_arg=ctypes.c_uint64(buffers.d_out.value),
        sums_arg=ctypes.c_uint64(buffers.d_sums.value),
        channel_sums_arg=ctypes.c_uint64(buffers.d_channel_sums.value),
        peaks_arg=ctypes.c_uint64(buffers.d_peaks.value),
        gains_arg=ctypes.c_uint64(buffers.d_gains.value),
        gains_next_arg=ctypes.c_uint64(buffers.d_gains_next.value),
        limiter_buf_arg=ctypes.c_uint64(buffers.d_limiter_buf.value or 0),
        limiter_prev_arg=ctypes.c_uint64(buffers.d_limiter_prev.value or 0),
        feedback_state_i_arg=ctypes.c_uint64(buffers.d_feedback_state_i.value or 0),
        feedback_state_d_arg=ctypes.c_uint64(buffers.d_feedback_state_d.value or 0),
        feedback_hist_arg=ctypes.c_uint64(buffers.d_feedback_hist.value or 0),
        safe_feedback_frames_arg=ctypes.c_uint64(buffers.d_safe_feedback_frames.value or 0),
        exact_sums_state_i_arg=ctypes.c_uint64(buffers.d_exact_sums_state_i.value or 0),
        exact_sums_state_d_arg=ctypes.c_uint64(buffers.d_exact_sums_state_d.value or 0),
        b_arg=ctypes.c_uint64(buffers.d_b.value),
        a_arg=ctypes.c_uint64(buffers.d_a.value),
        q_states_arg=ctypes.c_uint64(buffers.d_q_states.value),
        start_states_arg=ctypes.c_uint64(buffers.d_start_states.value),
        hist_energies_arg=ctypes.c_uint64(buffers.d_hist_energies.value),
        hist_boundaries_arg=ctypes.c_uint64(buffers.d_hist_boundaries.value),
        metrics_arg=ctypes.c_uint64(buffers.d_metrics.value),
        source_short_ring_arg=ctypes.c_uint64(buffers.d_source_short_ring.value or 0),
        source_exact_sums_arg=ctypes.c_uint64(buffers.d_source_exact_sums.value or 0),
        source_exact_audit_sums_arg=ctypes.c_uint64(buffers.d_source_exact_audit_sums.value or 0),
        source_start_states_arg=ctypes.c_uint64(buffers.d_source_start_states.value or 0),
        source_energy_arg=ctypes.c_uint64(buffers.d_source_energy.value or 0),
        source_block_sums_arg=ctypes.c_uint64(buffers.d_source_block_sums.value or 0),
        channels_arg=ctypes.c_uint32(args.channels),
        frame_window_arg=ctypes.c_uint32(cfg.frames_per_window),
        windows_arg=ctypes.c_uint32(cfg.windows),
        target_i_arg=ctypes.c_float(args.target_i),
        target_lra_arg=ctypes.c_float(args.target_lra),
        target_tp_arg=ctypes.c_float(args.target_tp),
        measured_i_arg=ctypes.c_float(args.measured_i if cfg.has_measured else 0.0),
        measured_thresh_arg=ctypes.c_float(args.measured_thresh if cfg.has_measured else -70.0),
        offset_db_arg=ctypes.c_float(cfg.runtime_offset_db),
        linear_mode_arg=ctypes.c_uint32(1 if cfg.linear_mode else 0),
        ceiling_arg=ctypes.c_float(cfg.apply_ceiling),
        exact_limiter_ceiling_arg=ctypes.c_double(cfg.apply_ceiling),
        exact_target_i_arg=ctypes.c_double(args.target_i),
        exact_target_lra_arg=ctypes.c_double(args.target_lra),
        exact_measured_i_arg=ctypes.c_double(args.measured_i if cfg.has_measured else 0.0),
        exact_measured_thresh_arg=ctypes.c_double(args.measured_thresh if cfg.has_measured else -70.0),
        exact_offset_amp_arg=ctypes.c_double(db_to_amp(cfg.runtime_offset_db)),
        limiter_lookahead_arg=ctypes.c_uint32(cfg.limiter_lookahead_frames),
        total_frames_arg=ctypes.c_uint32(cfg.total_frames),
        gain_timing_offset_arg=ctypes.c_uint32(frame_size(args.rate, args.ffmpeg_gain_offset_ms)),
        attack_length_arg=ctypes.c_uint32(frame_size(args.rate, 10)),
        release_length_arg=ctypes.c_uint32(frame_size(args.rate, 100)),
    )
