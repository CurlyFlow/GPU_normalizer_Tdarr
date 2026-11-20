from __future__ import annotations

import sys
import threading
import time
from contextlib import ExitStack
from dataclasses import dataclass
from typing import Any

from cuda_driver import has_async_apply_api, has_ctx_push_api
from exact_stream_window import ExactLimiterStreamWindow
from feedback_apply import new_feedback_state_i
from runtime_env import env_flag as _env_flag, env_nonnegative_int as _env_nonnegative_int
from first_pass_output_native import reset_first_pass_output_metrics
from stream_encode_writer_factory import maybe_async_encode_writer
from stream_ingress_resample import IngressResamplingReadHandle
from stream_processes import finish_decode_pass, finish_encode_pass, start_decode_pass, start_encode_pass
from sync_apply_output import ExactAsyncOutput, SyncPinnedBorrowedOutput
from sync_apply_result_capture import capture_sync_apply_close_results


@dataclass
class SyncApplyState:
    active: bool
    done_bytes: int
    frame_offset: int
    exact_final_flush_frames: int
    exact_use_final_flush: bool
    exact_prefinal_frames: int
    feedback_state_i_host: Any
    exact_transition_logged: bool
    decode_proc: Any
    fi: Any
    encode_proc: Any
    fo: Any
    async_writer: Any
    exact_stream_window: Any
    async_output: Any
    borrowed_output: Any


def _run_cleanup(errors, action, *args, **kwargs):
    try:
        return action(*args, **kwargs)
    except BaseException as exc:
        errors.append(exc)
        return None


def _close_sync_streams(result, decode_proc, fi, encode_proc, fo, *, abort=False):
    errors = []
    if abort:
        _run_cleanup(errors, _abort_open_stream, decode_proc, fi)
        _run_cleanup(errors, _abort_open_stream, encode_proc, fo)
    else:
        _run_cleanup(errors, fi.close)
        decode_wait = _run_cleanup(errors, finish_decode_pass, decode_proc, 'streaming decode pass 2')
        encode_times = _run_cleanup(errors, finish_encode_pass, encode_proc, fo)
        if decode_wait is not None:
            result.apply_decode_wait_time += decode_wait
        if encode_times is not None:
            result.apply_encode_close_time += encode_times[0]
            result.apply_encode_wait_time += encode_times[1]
    if errors:
        raise errors[0]


def open_sync_apply_state(ctx, result, *, force_prefetch=False):
    with ExitStack() as unwind:
        state = _open_sync_apply_state(ctx, result, force_prefetch=force_prefetch, unwind=unwind)
        unwind.pop_all()
        return state


def _abort_open_stream(proc, handle):
    try:
        if proc is not None:
            proc.kill()
    finally:
        try:
            if hasattr(handle, 'abort'):
                handle.abort()
            else:
                handle.close()
        except BrokenPipeError:
            pass
        finally:
            if proc is not None:
                proc.wait()


def _open_sync_apply_state(ctx, result, *, force_prefetch, unwind):
    cuda = ctx.cuda
    args = ctx.args
    cfg = ctx.cfg
    exact_first_frame_length = cfg.input_shape.frames_per_window * 30
    exact_final_flush_frames = max(0, exact_first_frame_length - cfg.input_shape.frames_per_window)
    exact_use_final_flush = cfg.loudnorm_mode.exact_limiter_active and cfg.input_shape.total_frames > exact_first_frame_length and exact_final_flush_frames > 0 and cfg.input_shape.total_frames > exact_final_flush_frames
    exact_prefinal_frames = cfg.input_shape.total_frames - exact_final_flush_frames if exact_use_final_flush else cfg.input_shape.total_frames
    feedback_state_i_host = new_feedback_state_i(profile_counts=cfg.exact.exact_profile_counts, prefilled_output=cfg.exact.exact_use_prefilled_output)
    reset_first_pass_output_metrics(ctx)
    encode_first = bool(
        cfg.root.streaming_io
        and cfg.input_shape.encode_command
        and cfg.input_shape.encode_command[0] == '__loudnorm_open_fifo_write__'
        and not _env_flag('LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DIRECT_FIFO_WRITE_DECODE_FIRST', True)
    )
    decode_proc = None
    encode_proc = None
    fi = None
    fo = None
    if cfg.input_shape.ingress_rate != args.rate:
        decode_proc = None
        fi = IngressResamplingReadHandle(args, cfg, cfg.input_shape.decode_command, 'streaming decode pass 2').open()
        unwind.callback(_abort_open_stream, decode_proc, fi)
        encode_proc, fo = start_encode_pass(args, cfg.root.streaming_io, cfg.input_shape.encode_command)
        unwind.callback(_abort_open_stream, encode_proc, fo)
    elif encode_first:
        encode_proc, fo = start_encode_pass(args, cfg.root.streaming_io, cfg.input_shape.encode_command)
        unwind.callback(_abort_open_stream, encode_proc, fo)
        decode_proc, fi = start_decode_pass(args, cfg.root.streaming_io, cfg.input_shape.decode_command, 'streaming decode pass 2')
        unwind.callback(_abort_open_stream, decode_proc, fi)
    else:
        decode_proc, fi = start_decode_pass(args, cfg.root.streaming_io, cfg.input_shape.decode_command, 'streaming decode pass 2')
        unwind.callback(_abort_open_stream, decode_proc, fi)
        encode_proc, fo = start_encode_pass(args, cfg.root.streaming_io, cfg.input_shape.encode_command)
        unwind.callback(_abort_open_stream, encode_proc, fo)
    fo, async_writer = maybe_async_encode_writer(cfg.root.streaming_io, fo, chunk_bytes=cfg.sizing.output_chunk_bytes)
    if async_writer is not None:
        unwind.callback(fo.abort)
    async_output = None
    borrowed_output = None
    async_output_double_buffer = _env_flag('LOUDNORM_GPU_EXACT_APPLY_ASYNC_OUTPUT_DOUBLE_BUFFER')
    pinned_writer_output = _env_flag('LOUDNORM_GPU_EXACT_OUTPUT_PINNED_WRITER')
    event_writer_output = _env_flag('LOUDNORM_GPU_EXACT_OUTPUT_EVENT_WRITER')
    async_output_requested = _env_flag('LOUDNORM_GPU_EXACT_APPLY_ASYNC_OUTPUT') or _env_flag('LOUDNORM_GPU_EXACT_APPLY_ASYNC_OUTPUT_DIRECT') or async_output_double_buffer or pinned_writer_output or event_writer_output
    if async_output_requested and has_async_apply_api(cuda):
        try:
            if event_writer_output and (async_writer is None or not hasattr(fo, 'write_cuda_event_borrowed') or not has_ctx_push_api(cuda)):
                raise RuntimeError('event writer requested without async writer/context push support')
            async_output = ExactAsyncOutput(
                cuda,
                ctx.buffers,
                output_chunk_bytes=cfg.sizing.output_chunk_bytes,
                direct_device_output=_env_flag('LOUDNORM_GPU_EXACT_APPLY_ASYNC_OUTPUT_DIRECT') or async_output_double_buffer or event_writer_output,
                double_buffer=async_output_double_buffer,
                pinned_writer=pinned_writer_output,
                pinned_writer_slots=_env_nonnegative_int('LOUDNORM_GPU_EXACT_OUTPUT_PINNED_WRITER_SLOTS', 4),
                event_writer=event_writer_output,
                event_writer_slots=_env_nonnegative_int('LOUDNORM_GPU_EXACT_OUTPUT_EVENT_WRITER_SLOTS', 16),
                cuda_context=ctx.cuda_session.ctx,
            )
            unwind.callback(async_output.cleanup, cuda, wait=False)
        except Exception:
            if event_writer_output:
                raise
            async_output = None
    if (
        async_output is None
        and async_writer is not None
        and hasattr(fo, 'write_borrowed')
        and has_async_apply_api(cuda)
        and _env_flag('LOUDNORM_GPU_SYNC_OUTPUT_PINNED_BORROWED')
    ):
        try:
            borrowed_output = SyncPinnedBorrowedOutput(
                cuda,
                cfg.sizing.output_chunk_bytes,
                _env_nonnegative_int('LOUDNORM_GPU_SYNC_OUTPUT_PINNED_BORROWED_SLOTS', 640),
            )
            unwind.callback(borrowed_output.cleanup, cuda, wait=False)
        except Exception:
            borrowed_output = None
    exact_prefetch_extra_chunks = _env_nonnegative_int('LOUDNORM_GPU_PAIR_FALLBACK_APPLY_PREFETCH_EXTRA_CHUNKS', 64) if force_prefetch else 2
    exact_stream_window = ExactLimiterStreamWindow(
        fi,
        ctx.host_io.host_in,
        frame_bytes=cfg.sizing.frame_bytes,
        chunk_bytes=cfg.sizing.chunk_bytes,
        apply_input_chunk_bytes=cfg.sizing.exact_apply_input_chunk_bytes,
        prefetch_enabled=True if force_prefetch else None,
        prefetch_extra_chunks=exact_prefetch_extra_chunks,
        limit_frames=cfg.input_shape.total_frames if _env_flag('LOUDNORM_GPU_EXACT_STREAM_WINDOW_LIMIT_TOTAL_FRAMES') else None,
    ) if cfg.root.streaming_io and cfg.loudnorm_mode.exact_limiter_active else None
    return SyncApplyState(
        active=True,
        done_bytes=0,
        frame_offset=0,
        exact_final_flush_frames=exact_final_flush_frames,
        exact_use_final_flush=exact_use_final_flush,
        exact_prefinal_frames=exact_prefinal_frames,
        feedback_state_i_host=feedback_state_i_host,
        exact_transition_logged=False,
        decode_proc=decode_proc,
        fi=fi,
        encode_proc=encode_proc,
        fo=fo,
        async_writer=async_writer,
        exact_stream_window=exact_stream_window,
        async_output=async_output,
        borrowed_output=borrowed_output,
    )


def close_sync_apply_state(ctx, result, state):
    cuda = ctx.cuda
    exc_active = sys.exc_info()[0] is not None
    errors = []
    async_cleanup_pending = state.async_output is not None
    if state.async_output is not None and not exc_active:
        _run_cleanup(errors, state.async_output.finish_pending, cuda, result, state.fo, drain=True)
        if not errors:
            _run_cleanup(errors, state.async_output.cleanup, cuda)
            async_cleanup_pending = False
    if state.exact_stream_window is not None:
        stream_window_close_t0 = time.perf_counter()
        _run_cleanup(errors, state.exact_stream_window.close)
        result.apply_stream_window_close_time += time.perf_counter() - stream_window_close_t0
    stream_close_t0 = time.perf_counter()
    _run_cleanup(errors, _close_sync_streams, result, state.decode_proc, state.fi, state.encode_proc, state.fo,
                 abort=exc_active or bool(errors))
    result.apply_stream_close_time += time.perf_counter() - stream_close_t0
    if async_cleanup_pending:
        _run_cleanup(errors, state.async_output.cleanup, cuda, wait=False)
    if state.borrowed_output is not None:
        _run_cleanup(errors, state.borrowed_output.cleanup, cuda, wait=not (exc_active or errors))
        result.apply_async_output_borrow_wait_time += getattr(state.borrowed_output, 'borrow_wait_time', 0.0)
        result.apply_async_output_borrowed_writes += getattr(state.borrowed_output, 'borrowed_writes', 0)
        result.apply_async_output_borrowed_bytes += getattr(state.borrowed_output, 'borrowed_bytes', 0)
        result.apply_async_output_borrowed_peak_slots = max(
            result.apply_async_output_borrowed_peak_slots,
            getattr(state.borrowed_output, 'borrowed_peak_slots', 0),
        )
    if state.async_writer is not None:
        result.apply_async_write = 1
        result.apply_async_write_worker_time += state.async_writer.worker_write_time
        result.apply_async_write_close_wait_time += state.async_writer.close_wait_time
        result.apply_async_write_peak_queue = max(result.apply_async_write_peak_queue, state.async_writer.peak_queue)
        result.apply_async_write_borrowed_writes += getattr(state.async_writer, 'borrowed_writes', 0)
        result.apply_async_write_borrowed_bytes += getattr(state.async_writer, 'borrowed_bytes', 0)
        result.apply_async_write_cuda_event_writes += getattr(state.async_writer, 'cuda_event_writes', 0)
        result.apply_async_write_cuda_event_wait_time += getattr(state.async_writer, 'cuda_event_wait_time', 0.0)
    if state.async_output is not None:
        result.apply_async_output_borrow_wait_time += getattr(state.async_output, 'borrow_wait_time', 0.0)
        result.apply_async_output_borrowed_writes += getattr(state.async_output, 'borrowed_writes', 0)
        result.apply_async_output_borrowed_bytes += getattr(state.async_output, 'borrowed_bytes', 0)
        result.apply_async_output_borrowed_peak_slots = max(
            result.apply_async_output_borrowed_peak_slots,
            getattr(state.async_output, 'borrowed_peak_slots', 0),
        )

    if errors or exc_active:
        if errors and not exc_active:
            raise errors[0]
        return
    capture_sync_apply_close_results(ctx, result)


def close_paired_sync_apply_states(primary_ctx, primary_result, primary_state, partner_ctx, partner_result, partner_state):
    if (
        not _env_flag('LOUDNORM_GPU_PAIR_FALLBACK_APPLY_PARALLEL_CLOSE', True)
        or sys.exc_info()[0] is not None
        or primary_ctx.cfg.exact.exact_profile_counts
        or partner_ctx.cfg.exact.exact_profile_counts
        or primary_ctx.cfg.exact.audit_ffmpeg_state_snapshots
        or partner_ctx.cfg.exact.audit_ffmpeg_state_snapshots
    ):
        exc_active = sys.exc_info()[0] is not None
        errors = []
        try:
            close_sync_apply_state(primary_ctx, primary_result, primary_state)
        except BaseException as exc:
            errors.append(exc)
            # Keep the primary failure active while the partner aborts its streams.
            _run_cleanup(errors, close_sync_apply_state, partner_ctx, partner_result, partner_state)
        else:
            _run_cleanup(errors, close_sync_apply_state, partner_ctx, partner_result, partner_state)
        if errors and not exc_active:
            raise errors[0]
        return

    errors = []

    def close_one(ctx, result, state):
        try:
            close_sync_apply_state(ctx, result, state)
        except BaseException as exc:
            errors.append(exc)

    primary_thread = threading.Thread(
        target=close_one,
        args=(primary_ctx, primary_result, primary_state),
        name='paired apply primary close',
    )
    partner_thread = threading.Thread(
        target=close_one,
        args=(partner_ctx, partner_result, partner_state),
        name='paired apply partner close',
    )
    primary_thread.start()
    partner_thread.start()
    primary_thread.join()
    partner_thread.join()
    if errors:
        raise errors[0]
