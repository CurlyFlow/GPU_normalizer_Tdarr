from __future__ import annotations

import ctypes
from dataclasses import dataclass

from exact_apply_plan import plan_exact_limiter_chunk
from first_pass_output_metrics import inline_first_pass_output_sums
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
    frame_offset: int = 0
    input_base_arg: ctypes.c_uint32 | None = None
    input_frames_arg: ctypes.c_uint32 | None = None
    arg_refs: tuple[object, ...] = ()


def prepare_sync_apply_chunk(ctx, result, fi, exact_stream_window, *, done_bytes, frame_offset, exact_use_final_flush, exact_prefinal_frames, exact_final_flush_frames, exact_safe_skip_chunk_bytes=None):
    args = ctx.args
    cfg = ctx.cfg
    bindings = ctx.bindings
    host_in = ctx.host_io.host_in

    if cfg.loudnorm_mode.exact_limiter_active:
        exact_plan = plan_exact_limiter_chunk(
            total_frames=cfg.input_shape.total_frames,
            frame_offset=frame_offset,
            chunk_bytes=cfg.sizing.chunk_bytes,
            frame_bytes=cfg.sizing.frame_bytes,
            exact_use_final_flush=exact_use_final_flush,
            exact_prefinal_frames=exact_prefinal_frames,
            exact_final_flush_frames=exact_final_flush_frames,
            exact_sparse_chunks=cfg.exact.exact_sparse_chunks,
            prelimiter_unsafe_flags=ctx.prelimiter_unsafe_flags,
            windows=cfg.input_shape.windows,
            frames_per_window=cfg.input_shape.frames_per_window,
            limiter_lookahead_frames=cfg.limiter.limiter_lookahead_frames,
            exact_prefill_output=cfg.exact.exact_prefill_output,
            exact_safe_chunk_bytes=exact_safe_skip_chunk_bytes or cfg.sizing.exact_safe_chunk_bytes,
            exact_unsafe_chunk_bytes=cfg.sizing.exact_unsafe_chunk_bytes,
        )
        if exact_plan.sparse_split:
            result.exact_sparse_chunk_splits += 1
        this_frames = exact_plan.this_frames
        this_bytes = this_frames * cfg.sizing.frame_bytes
        this_samples = this_frames * args.channels
        input_base_frame = exact_plan.input_base_frame
        input_frames = exact_plan.input_frames
        if cfg.source.source_faithful_stereo:
            source_needed_end = min(cfg.input_shape.total_frames, frame_offset + this_frames + (cfg.input_shape.frames_per_window * 30))
            if source_needed_end > input_base_frame:
                input_frames = max(input_frames, source_needed_end - input_base_frame)
        copy_input_bytes = None
        if cfg.root.streaming_io:
            if hasattr(exact_stream_window, 'stage_to_device'):
                copy_input_bytes = exact_stream_window.stage_to_device(ctx, result, input_base_frame, input_frames)
            else:
                input_bytes = exact_stream_window.stage(input_base_frame, input_frames)
                copy_input_bytes = input_bytes
        else:
            input_bytes = input_frames * cfg.sizing.frame_bytes
            if input_bytes > len(host_in):
                raise RuntimeError(f'exact limiter input staging exceeded: need={input_bytes} capacity={len(host_in)}')
            fi.seek(input_base_frame * cfg.sizing.frame_bytes)
            got = fi.readinto(memoryview(host_in)[:input_bytes])
            if got != input_bytes:
                raise RuntimeError('short input read during exact limiter apply')
            copy_input_bytes = input_bytes
        input_base_arg = ctypes.c_uint32(input_base_frame)
        input_frames_arg = ctypes.c_uint32(input_frames)
        output_frames_arg = ctypes.c_uint32(this_frames)
        source_faithful_stereo_arg = ctypes.c_uint32(2 if cfg.source.source_exact_precompute else 1 if cfg.source.source_faithful_stereo else 0)
        source_sums_arg = bindings.source_exact_sums_arg if cfg.source.source_exact_precompute else bindings.start_states_arg
        inline_output_sums = inline_first_pass_output_sums(ctx)
        output_sums_arg = bindings.channel_sums_arg if inline_output_sums else ctypes.c_uint64(0)
        output_metric_state_i_arg = bindings.exact_sums_state_i_arg if inline_output_sums else ctypes.c_uint64(0)
        output_metric_state_d_arg = bindings.exact_sums_state_d_arg if inline_output_sums else ctypes.c_uint64(0)
        apply_args = kernel_args.build_exact_feedback_apply_args(
            bindings.in_arg,
            bindings.out_arg,
            bindings.sums_arg,
            source_sums_arg,
            bindings.source_short_ring_arg,
            output_sums_arg,
            output_metric_state_i_arg,
            output_metric_state_d_arg,
            bindings.hist_energies_arg,
            bindings.hist_boundaries_arg,
            bindings.limiter_buf_arg,
            bindings.limiter_prev_arg,
            bindings.feedback_state_i_arg,
            bindings.feedback_state_d_arg,
            bindings.feedback_hist_arg,
            bindings.ffmpeg_state_audit_i_arg,
            bindings.ffmpeg_state_audit_d_arg,
            bindings.ffmpeg_state_audit_max_events_arg,
            bindings.ffmpeg_state_audit_sample_windows_arg,
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
            this_output_bytes=this_samples * cfg.sizing.output_sample_bytes,
            copy_input_bytes=copy_input_bytes,
            apply_args=apply_args,
            grid_samples=1,
            kernel_label='apply exact feedback stream',
            exact_run_end_frame=exact_plan.exact_run_end_frame,
            exact_run_flag=exact_plan.exact_run_flag,
            frame_offset=frame_offset,
            input_base_arg=input_base_arg,
            input_frames_arg=input_frames_arg,
            arg_refs=(input_base_arg, input_frames_arg, output_frames_arg, source_faithful_stereo_arg, output_sums_arg, output_metric_state_i_arg, output_metric_state_d_arg),
        )

    this_bytes = min(cfg.sizing.chunk_bytes, cfg.input_shape.nbytes - done_bytes)
    if this_bytes % cfg.sizing.frame_bytes:
        raise RuntimeError('chunk is not frame-aligned')
    host_view = memoryview(host_in)
    if cfg.root.streaming_io:
        got = 0
        while got < this_bytes:
            chunk_got = fi.readinto(host_view[got:this_bytes])
            if not chunk_got:
                break
            got += chunk_got
        if got < this_bytes:
            if got % cfg.sizing.frame_bytes:
                raise RuntimeError('streaming apply ended with a partial frame')
            host_view[got:this_bytes] = b'\x00' * (this_bytes - got)
    else:
        got = fi.readinto(host_view[:this_bytes])
        if got != this_bytes:
            raise RuntimeError('short input read during apply')
    this_samples = this_bytes // cfg.root.input_sample_bytes
    this_frames = this_bytes // cfg.sizing.frame_bytes
    n_arg = ctypes.c_uint32(this_samples)
    offset_arg = ctypes.c_uint32(frame_offset)
    if getattr(cfg.loudnorm_mode, 'linear_f64_io', False):
        apply_args = kernel_args.build_linear_apply_args(
            bindings.in_arg,
            bindings.out_arg,
            bindings.exact_offset_amp_arg,
            n_arg,
            bindings.ceiling_arg,
        )
    elif cfg.loudnorm_mode.apply_ffmpeg_timing:
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
            final_apply=cfg.loudnorm_mode.parallel_final_apply,
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
        this_output_bytes=this_samples * cfg.sizing.output_sample_bytes,
        copy_input_bytes=this_bytes,
        apply_args=apply_args,
        grid_samples=min(65535, max(1, (this_samples + 255) // 256)),
        kernel_label='apply',
        frame_offset=frame_offset,
        arg_refs=(n_arg, offset_arg),
    )
