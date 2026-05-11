from __future__ import annotations

import ctypes
from dataclasses import dataclass

from exact_apply_plan import plan_exact_limiter_chunk
import kernel_args


@dataclass
class SyncApplyChunk:
    this_bytes: int
    this_frames: int
    this_samples: int
    this_output_bytes: int
    copy_input_bytes: int
    apply_args: object
    grid_samples: int
    kernel_label: str
    exact_run_end_frame: int = 0
    exact_run_flag: int = 0
    input_base_arg: ctypes.c_uint32 | None = None
    input_frames_arg: ctypes.c_uint32 | None = None
    arg_refs: tuple[object, ...] = ()


def prepare_sync_apply_chunk(ctx, result, fi, exact_stream_window, *, done_bytes, frame_offset, exact_use_final_flush, exact_prefinal_frames, exact_final_flush_frames):
    args = ctx.args
    cfg = ctx.cfg
    bindings = ctx.bindings
    host_in = ctx.host_io.host_in

    if cfg.exact_limiter_active:
        exact_plan = plan_exact_limiter_chunk(
            total_frames=cfg.total_frames,
            frame_offset=frame_offset,
            chunk_bytes=cfg.chunk_bytes,
            frame_bytes=cfg.frame_bytes,
            exact_use_final_flush=exact_use_final_flush,
            exact_prefinal_frames=exact_prefinal_frames,
            exact_final_flush_frames=exact_final_flush_frames,
            exact_sparse_chunks=cfg.exact_sparse_chunks,
            prelimiter_unsafe_flags=ctx.prelimiter_unsafe_flags,
            windows=cfg.windows,
            frames_per_window=cfg.frames_per_window,
            limiter_lookahead_frames=cfg.limiter_lookahead_frames,
            exact_prefill_output=cfg.exact_prefill_output,
        )
        if exact_plan.sparse_split:
            result.exact_sparse_chunk_splits += 1
        this_frames = exact_plan.this_frames
        this_bytes = this_frames * cfg.frame_bytes
        this_samples = this_frames * args.channels
        input_base_frame = exact_plan.input_base_frame
        input_frames = exact_plan.input_frames
        if cfg.source_faithful_stereo:
            source_needed_end = min(cfg.total_frames, frame_offset + this_frames + (cfg.frames_per_window * 30))
            if source_needed_end > input_base_frame:
                input_frames = max(input_frames, source_needed_end - input_base_frame)
        if cfg.streaming_io:
            input_bytes = exact_stream_window.stage(input_base_frame, input_frames)
        else:
            input_bytes = input_frames * cfg.frame_bytes
            if input_bytes > len(host_in):
                raise RuntimeError(f'exact limiter input staging exceeded: need={input_bytes} capacity={len(host_in)}')
            fi.seek(input_base_frame * cfg.frame_bytes)
            got = fi.readinto(memoryview(host_in)[:input_bytes])
            if got != input_bytes:
                raise RuntimeError('short input read during exact limiter apply')
        input_base_arg = ctypes.c_uint32(input_base_frame)
        input_frames_arg = ctypes.c_uint32(input_frames)
        output_frames_arg = ctypes.c_uint32(this_frames)
        source_faithful_stereo_arg = ctypes.c_uint32(2 if cfg.source_exact_precompute else 1 if cfg.source_faithful_stereo else 0)
        source_sums_arg = bindings.source_exact_sums_arg if cfg.source_exact_precompute else bindings.start_states_arg
        apply_args = kernel_args.build_exact_feedback_apply_args(
            bindings.in_arg,
            bindings.out_arg,
            bindings.sums_arg,
            source_sums_arg,
            bindings.source_short_ring_arg,
            bindings.hist_energies_arg,
            bindings.hist_boundaries_arg,
            bindings.limiter_buf_arg,
            bindings.limiter_prev_arg,
            bindings.feedback_state_i_arg,
            bindings.feedback_state_d_arg,
            bindings.feedback_hist_arg,
            bindings.total_frames_arg,
            input_base_arg,
            input_frames_arg,
            output_frames_arg,
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
            source_faithful_stereo_arg,
        )
        return SyncApplyChunk(
            this_bytes=this_bytes,
            this_frames=this_frames,
            this_samples=this_samples,
            this_output_bytes=this_samples * cfg.output_sample_bytes,
            copy_input_bytes=input_bytes,
            apply_args=apply_args,
            grid_samples=1,
            kernel_label='apply exact feedback stream',
            exact_run_end_frame=exact_plan.exact_run_end_frame,
            exact_run_flag=exact_plan.exact_run_flag,
            input_base_arg=input_base_arg,
            input_frames_arg=input_frames_arg,
            arg_refs=(input_base_arg, input_frames_arg, output_frames_arg, source_faithful_stereo_arg),
        )

    this_bytes = min(cfg.chunk_bytes, cfg.nbytes - done_bytes)
    if this_bytes % cfg.frame_bytes:
        raise RuntimeError('chunk is not frame-aligned')
    got = fi.readinto(memoryview(host_in)[:this_bytes])
    if got != this_bytes:
        raise RuntimeError('short input read during apply')
    this_samples = this_bytes // cfg.input_sample_bytes
    this_frames = this_bytes // cfg.frame_bytes
    n_arg = ctypes.c_uint32(this_samples)
    offset_arg = ctypes.c_uint32(frame_offset)
    if getattr(cfg, 'linear_f64_io', False):
        apply_args = kernel_args.build_linear_apply_args(
            bindings.in_arg,
            bindings.out_arg,
            bindings.exact_offset_amp_arg,
            n_arg,
            bindings.ceiling_arg,
        )
    elif cfg.apply_ffmpeg_timing:
        apply_args = kernel_args.build_ffmpeg_timing_apply_args(
            bindings.in_arg,
            bindings.out_arg,
            bindings.gains_arg,
            bindings.gains_next_arg,
            n_arg,
            bindings.channels_arg,
            bindings.frame_window_arg,
            bindings.windows_arg,
            offset_arg,
            bindings.limiter_lookahead_arg,
            bindings.gain_timing_offset_arg,
            bindings.total_frames_arg,
            bindings.ceiling_arg,
            final_apply=cfg.parallel_final_apply,
        )
    else:
        apply_args = kernel_args.build_apply_args(
            bindings.in_arg,
            bindings.out_arg,
            bindings.gains_arg,
            n_arg,
            bindings.channels_arg,
            bindings.frame_window_arg,
            bindings.windows_arg,
            offset_arg,
            bindings.ceiling_arg,
        )
    return SyncApplyChunk(
        this_bytes=this_bytes,
        this_frames=this_frames,
        this_samples=this_samples,
        this_output_bytes=this_samples * cfg.output_sample_bytes,
        copy_input_bytes=this_bytes,
        apply_args=apply_args,
        grid_samples=min(65535, max(1, (this_samples + 255) // 256)),
        kernel_label='apply',
        arg_refs=(n_arg, offset_arg),
    )
