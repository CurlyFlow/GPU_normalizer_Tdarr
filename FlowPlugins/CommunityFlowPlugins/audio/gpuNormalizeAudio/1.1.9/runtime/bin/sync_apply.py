from __future__ import annotations

import array
import ctypes
import sys
import time

from cuda_driver import chk
from exact_stream_window import ExactLimiterStreamWindow
from feedback_apply import new_feedback_state_i
from stream_io import finish_decode_pass, finish_encode_pass, start_decode_pass, start_encode_pass
from sync_apply_chunks import prepare_sync_apply_chunk
from sync_feedback import (
    apply_exact_risk_gate,
    classify_exact_chunk,
    launch_sync_apply_kernel,
    prefill_exact_output,
    refresh_exact_feedback_state,
)


def _copy_sync_input(ctx, result, copy_input_bytes):
    t0 = time.perf_counter()
    chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_in, ctypes.c_void_p(ctx.host_io.host_in_ptr), copy_input_bytes), 'cuMemcpyHtoD(apply input)')
    copy_dt = time.perf_counter() - t0
    result.apply_h2d_time += copy_dt
    result.total_h2d_time += copy_dt


def _copy_sync_output(ctx, result, fo, *, this_output_bytes, stage_t0):
    t0 = time.perf_counter()
    chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(ctx.host_io.host_out_ptr), ctx.buffers.d_out, this_output_bytes), 'cuMemcpyDtoH(output)')
    copy_dt = time.perf_counter() - t0
    result.apply_d2h_time += copy_dt
    result.total_d2h_time += copy_dt
    result.apply_wall_time += time.perf_counter() - stage_t0
    fo.write(memoryview(ctx.host_io.host_out)[:this_output_bytes])


def _close_sync_streams(decode_proc, fi, encode_proc, fo):
    exc_active = sys.exc_info()[0] is not None
    try:
        fi.close()
    finally:
        if exc_active:
            if decode_proc is not None:
                decode_proc.kill()
                decode_proc.wait()
            if encode_proc is not None:
                try:
                    fo.close()
                except BrokenPipeError:
                    pass
                encode_proc.kill()
                encode_proc.wait()
        else:
            try:
                finish_decode_pass(decode_proc, 'streaming decode pass 2')
            finally:
                finish_encode_pass(encode_proc, fo)


def run_sync_apply(ctx, result):
    cuda = ctx.cuda
    args = ctx.args
    cfg = ctx.cfg
    done_bytes = 0
    frame_offset = 0
    exact_first_frame_length = cfg.frames_per_window * 30
    exact_final_flush_frames = max(0, exact_first_frame_length - cfg.frames_per_window)
    exact_use_final_flush = cfg.exact_limiter_active and cfg.total_frames > exact_first_frame_length and exact_final_flush_frames > 0 and cfg.total_frames > exact_final_flush_frames
    exact_prefinal_frames = cfg.total_frames - exact_final_flush_frames if exact_use_final_flush else cfg.total_frames
    feedback_state_i_host = new_feedback_state_i(prefilled_output=cfg.exact_use_prefilled_output)
    exact_transition_logged = False
    decode_proc, fi = start_decode_pass(args, cfg.streaming_io, cfg.decode_command, 'streaming decode pass 2')
    encode_proc, fo = start_encode_pass(args, cfg.streaming_io, cfg.encode_command)
    try:
        exact_stream_window = ExactLimiterStreamWindow(fi, ctx.host_io.host_in, frame_bytes=cfg.frame_bytes, chunk_bytes=cfg.chunk_bytes, apply_input_chunk_bytes=cfg.apply_input_chunk_bytes) if cfg.streaming_io else None

        while done_bytes < cfg.nbytes:
            apply_chunk = prepare_sync_apply_chunk(
                ctx,
                result,
                fi,
                exact_stream_window,
                done_bytes=done_bytes,
                frame_offset=frame_offset,
                exact_use_final_flush=exact_use_final_flush,
                exact_prefinal_frames=exact_prefinal_frames,
                exact_final_flush_frames=exact_final_flush_frames,
            )
            stage_t0 = time.perf_counter()
            exact_chunk_unsafe, skip_safe_fill_chunk = classify_exact_chunk(
                ctx,
                result,
                frame_offset=frame_offset,
                this_frames=apply_chunk.this_frames,
                exact_run_end_frame=apply_chunk.exact_run_end_frame,
                exact_run_flag=apply_chunk.exact_run_flag,
            )

            _copy_sync_input(ctx, result, apply_chunk.copy_input_bytes)
            apply_exact_risk_gate(ctx, result, feedback_state_i_host, exact_chunk_unsafe)
            prefill_exact_output(
                ctx,
                result,
                feedback_state_i_host,
                frame_offset=frame_offset,
                this_samples=apply_chunk.this_samples,
                this_frames=apply_chunk.this_frames,
                input_base_arg=apply_chunk.input_base_arg,
                exact_chunk_unsafe=exact_chunk_unsafe,
                skip_safe_fill_chunk=skip_safe_fill_chunk,
            )
            launch_sync_apply_kernel(
                ctx,
                result,
                apply_chunk,
                feedback_state_i_host,
                exact_chunk_unsafe=exact_chunk_unsafe,
                frame_offset=frame_offset,
                exact_prefinal_frames=exact_prefinal_frames,
            )

            exact_transition_logged = refresh_exact_feedback_state(
                ctx,
                feedback_state_i_host,
                frame_offset=frame_offset,
                exact_transition_logged=exact_transition_logged,
            )
            _copy_sync_output(ctx, result, fo, this_output_bytes=apply_chunk.this_output_bytes, stage_t0=stage_t0)
            done_bytes += apply_chunk.this_bytes
            frame_offset += apply_chunk.this_frames
            ctx.emit_progress('apply', 0.75 + 0.25 * (done_bytes / float(cfg.nbytes)))
    finally:
        _close_sync_streams(decode_proc, fi, encode_proc, fo)

    if cfg.exact_limiter_active and cfg.exact_profile_counts:
        result.exact_counts_host = array.array('d', [0.0]) * 128
        chk(cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(result.exact_counts_host.buffer_info()[0]), ctx.buffers.d_feedback_state_d, 128 * 8), 'cuMemcpyDtoH(exact profile counts)')
