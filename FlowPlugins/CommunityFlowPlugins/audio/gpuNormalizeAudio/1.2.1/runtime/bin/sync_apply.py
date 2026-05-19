from __future__ import annotations

import array
import ctypes
import sys
import time

from cuda_driver import chk
from cuda_launch import launch_timed_kernel
from exact_stream_window import ExactLimiterStreamWindow
from feedback_apply import new_feedback_state_i
import kernel_args
from stream_io import finish_decode_pass, finish_encode_pass, maybe_async_encode_writer, start_decode_pass, start_encode_pass
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
    out_view = memoryview(ctx.host_io.host_out)[:this_output_bytes]
    write_t0 = time.perf_counter()
    fo.write(out_view)
    result.apply_write_time += time.perf_counter() - write_t0


def _reset_first_pass_output_metrics(ctx):
    if not ctx.cfg.emit_first_pass_json:
        return
    chk(ctx.cuda.cuMemsetD32_v2(ctx.buffers.d_channel_sums, 0, ctx.cfg.windows * 2), 'cuMemsetD32(first-pass output sums)')
    chk(ctx.cuda.cuMemsetD32_v2(ctx.buffers.d_exact_sums_state_i, 0, 8), 'cuMemsetD32(first-pass output state_i)')
    chk(ctx.cuda.cuMemsetD32_v2(ctx.buffers.d_exact_sums_state_d, 0, (ctx.args.channels * 4 + 1) * 2), 'cuMemsetD32(first-pass output state_d)')


def _capture_first_pass_output_metrics(ctx, result, apply_chunk):
    if not ctx.cfg.emit_first_pass_json:
        return
    frames_arg = ctypes.c_uint32(apply_chunk.this_frames)
    exact_args = kernel_args.build_exact_sums_args(
        ctx.bindings.out_arg,
        ctx.bindings.channel_sums_arg,
        ctx.bindings.exact_sums_state_i_arg,
        ctx.bindings.exact_sums_state_d_arg,
        frames_arg,
        ctx.bindings.channels_arg,
        ctx.bindings.frame_window_arg,
        ctx.bindings.b_arg,
        ctx.bindings.a_arg,
    )
    dt = launch_timed_kernel(ctx.cuda, 'first-pass-output-sums', ctx.kernels.exact_sums_fn, exact_args)
    result.apply_kernel_time += dt
    result.first_pass_output_metric_kernel_time += dt


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
                    if hasattr(fo, 'abort'):
                        fo.abort()
                    else:
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
    _reset_first_pass_output_metrics(ctx)
    decode_proc, fi = start_decode_pass(args, cfg.streaming_io, cfg.decode_command, 'streaming decode pass 2')
    encode_proc, fo = start_encode_pass(args, cfg.streaming_io, cfg.encode_command)
    fo, async_writer = maybe_async_encode_writer(cfg.streaming_io, fo, chunk_bytes=cfg.output_chunk_bytes)
    try:
        exact_stream_window = ExactLimiterStreamWindow(fi, ctx.host_io.host_in, frame_bytes=cfg.frame_bytes, chunk_bytes=cfg.chunk_bytes, apply_input_chunk_bytes=cfg.exact_apply_input_chunk_bytes) if cfg.streaming_io and cfg.exact_limiter_active else None

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
            if apply_chunk is None:
                break
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
            _capture_first_pass_output_metrics(ctx, result, apply_chunk)

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
        if exact_stream_window is not None:
            exact_stream_window.close()
        _close_sync_streams(decode_proc, fi, encode_proc, fo)

    if async_writer is not None:
        result.apply_async_write = 1
        result.apply_async_write_worker_time += async_writer.worker_write_time
        result.apply_async_write_close_wait_time += async_writer.close_wait_time
        result.apply_async_write_peak_queue = max(result.apply_async_write_peak_queue, async_writer.peak_queue)

    if cfg.exact_limiter_active and cfg.exact_profile_counts:
        result.exact_counts_host = array.array('d', [0.0]) * 128
        chk(cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(result.exact_counts_host.buffer_info()[0]), ctx.buffers.d_feedback_state_d, 128 * 8), 'cuMemcpyDtoH(exact profile counts)')
