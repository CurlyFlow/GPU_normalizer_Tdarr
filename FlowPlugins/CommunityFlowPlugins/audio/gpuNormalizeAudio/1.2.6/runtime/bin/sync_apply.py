from __future__ import annotations

import array
import ctypes
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any

from cuda_driver import alloc_pinned_host_buffer, chk, has_async_apply_api
from cuda_launch import launch_timed_kernel
from exact_stream_window import ExactLimiterStreamWindow
from feedback_apply import feedback_state_i_view, new_feedback_state_i
import kernel_args
from runtime_env import env_flag as _env_flag, env_nonnegative_int as _env_nonnegative_int
from stats_channel_native import init_native_output_sums, run_native_output_sums_chunk
from stream_io import finish_decode_pass, finish_encode_pass, maybe_async_encode_writer, start_decode_pass, start_encode_pass
from sync_apply_chunks import prepare_sync_apply_chunk
from sync_feedback import (
    apply_exact_risk_gate,
    classify_exact_chunk,
    launch_sync_apply_kernel,
    prefill_exact_output,
    refresh_exact_feedback_state,
)


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


class ExactAsyncOutput:
    def __init__(self, cuda, buffers, *, output_chunk_bytes, direct_device_output=False, double_buffer=False, pinned_writer=False, pinned_writer_slots=0):
        self.streams = []
        self.pinned_ptrs = []
        self.pinned_raws = []
        self.pinned_views = []
        self.pending = []
        self.current_slot = None
        self.direct_device_output = direct_device_output
        self.double_buffer = bool(double_buffer and direct_device_output)
        self.pinned_writer = bool(pinned_writer)
        self.borrowed_host_slots = set()
        self.borrow_condition = threading.Condition()
        self.borrow_wait_time = 0.0
        self.borrowed_writes = 0
        self.borrowed_bytes = 0
        self.borrowed_peak_slots = 0
        chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_apply_out_b), output_chunk_bytes), 'cuMemAlloc(exact async output b)')
        host_slots = 2 if self.double_buffer else 1
        if self.pinned_writer:
            host_slots = max(host_slots, max(2, int(pinned_writer_slots or 0)))
        for slot in range(host_slots):
            stream = ctypes.c_void_p()
            label = f'exact async output {slot}' if host_slots > 1 else 'exact async output'
            chk(cuda.cuStreamCreate(ctypes.byref(stream), 0), f'cuStreamCreate({label})')
            pinned_ptr, pinned_raw, pinned_view = alloc_pinned_host_buffer(cuda, output_chunk_bytes, label)
            self.streams.append(stream)
            self.pinned_ptrs.append(pinned_ptr)
            self.pinned_raws.append(pinned_raw)
            self.pinned_views.append(pinned_view)
        self.device_outputs = [buffers.d_out, buffers.d_apply_out_b]
        self.device_output_args = [ctypes.c_uint64(buffers.d_out.value), ctypes.c_uint64(buffers.d_apply_out_b.value)]

    def select_output(self, ctx):
        if not self.direct_device_output:
            return
        pending_slots = {record['device_slot'] for record in self.pending}
        slot = next((idx for idx in range(len(self.device_outputs)) if idx not in pending_slots), None)
        if slot is None:
            raise RuntimeError('no free exact async direct output slot')
        self.current_slot = slot
        ctx.bindings.out_arg = self.device_output_args[slot]
        if hasattr(ctx, '_safe_feedback_apply6_arg_cache'):
            delattr(ctx, '_safe_feedback_apply6_arg_cache')

    def finish_pending(self, cuda, result, fo, *, drain=False):
        while self.pending:
            record = self.pending.pop(0)
            self._finish_record(cuda, result, fo, record)
            if not drain:
                break

    def _finish_record(self, cuda, result, fo, record):
        t0 = time.perf_counter()
        chk(cuda.cuStreamSynchronize(record['stream']), 'cuStreamSynchronize(exact async output)')
        wait_dt = time.perf_counter() - t0
        result.apply_d2h_time += wait_dt
        result.total_d2h_time += wait_dt
        out_view = record['view'][:record['bytes']]
        write_t0 = time.perf_counter()
        if self.pinned_writer and hasattr(fo, 'write_borrowed'):
            release = self._borrow_host_slot(record['host_slot'], record['bytes'])
            try:
                fo.write_borrowed(out_view, release)
            except BaseException:
                release()
                raise
            self.borrowed_writes += 1
            self.borrowed_bytes += record['bytes']
        else:
            fo.write(out_view)
        result.apply_write_time += time.perf_counter() - write_t0

    def _pending_host_slots(self):
        return {record['host_slot'] for record in self.pending}

    def _acquire_host_slot(self):
        if not self.pinned_writer:
            return self.current_slot if self.double_buffer and self.direct_device_output else 0
        wait_t0 = None
        with self.borrow_condition:
            while True:
                busy = self._pending_host_slots() | self.borrowed_host_slots
                for slot in range(len(self.pinned_views)):
                    if slot not in busy:
                        if wait_t0 is not None:
                            self.borrow_wait_time += time.perf_counter() - wait_t0
                        return slot
                if wait_t0 is None:
                    wait_t0 = time.perf_counter()
                self.borrow_condition.wait(timeout=0.05)

    def _borrow_host_slot(self, host_slot, byte_count):
        with self.borrow_condition:
            self.borrowed_host_slots.add(host_slot)
            self.borrowed_peak_slots = max(self.borrowed_peak_slots, len(self.borrowed_host_slots))
        released = False

        def release():
            nonlocal released
            with self.borrow_condition:
                if released:
                    return
                released = True
                self.borrowed_host_slots.discard(host_slot)
                self.borrow_condition.notify_all()

        return release

    def wait_borrowed(self):
        wait_t0 = None
        with self.borrow_condition:
            while self.borrowed_host_slots:
                if wait_t0 is None:
                    wait_t0 = time.perf_counter()
                self.borrow_condition.wait(timeout=0.05)
            if wait_t0 is not None:
                self.borrow_wait_time += time.perf_counter() - wait_t0

    def queue_output(self, cuda, result, buffers, *, this_output_bytes):
        t0 = time.perf_counter()
        device_slot = None
        if self.direct_device_output:
            if self.current_slot is None:
                raise RuntimeError('exact async direct output slot was not selected')
            device_slot = self.current_slot
            output_ptr = self.device_outputs[self.current_slot]
        else:
            chk(cuda.cuMemcpyDtoD_v2(buffers.d_apply_out_b, buffers.d_out, this_output_bytes), 'cuMemcpyDtoD(exact async output)')
            output_ptr = buffers.d_apply_out_b
        host_slot = self._acquire_host_slot()
        stream = self.streams[host_slot]
        pinned_ptr = self.pinned_ptrs[host_slot]
        pinned_view = self.pinned_views[host_slot]
        self.current_slot = None
        chk(cuda.cuMemcpyDtoHAsync_v2(ctypes.c_void_p(pinned_ptr.value), output_ptr, this_output_bytes, stream), 'cuMemcpyDtoHAsync(exact output)')
        result.apply_d2h_time += time.perf_counter() - t0
        self.pending.append({
            'bytes': this_output_bytes,
            'device_slot': device_slot,
            'host_slot': host_slot,
            'stream': stream,
            'view': pinned_view,
        })

    def cleanup(self, cuda):
        self.wait_borrowed()
        for stream in self.streams:
            if stream.value:
                cuda.cuStreamDestroy_v2(stream)
        self.streams = []
        for pinned_ptr in self.pinned_ptrs:
            if pinned_ptr.value:
                cuda.cuMemFreeHost(pinned_ptr)
        self.pinned_ptrs = []
        self.pinned_raws = []
        self.pinned_views = []

def _copy_sync_input(ctx, result, copy_input_bytes):
    if copy_input_bytes <= 0:
        return
    t0 = time.perf_counter()
    chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_in, ctypes.c_void_p(ctx.host_io.host_in_ptr), copy_input_bytes), 'cuMemcpyHtoD(apply input)')
    copy_dt = time.perf_counter() - t0
    result.apply_h2d_time += copy_dt
    result.total_h2d_time += copy_dt


def _capture_first_pass_output_metrics_native(ctx, result, payload_ptr, frames, frame_offset):
    if not (ctx.cfg.emit_first_pass_json and _env_flag('LOUDNORM_GPU_FIRST_PASS_OUTPUT_NATIVE', True)):
        return
    native_state = getattr(ctx, 'native_first_pass_output_sums', None)
    if native_state is None:
        native_state = init_native_output_sums(ctx)
        ctx.native_first_pass_output_sums = native_state
    dt = run_native_output_sums_chunk(ctx, native_state, payload_ptr, frames, frame_offset)
    result.first_pass_output_metric_kernel_time += dt


def _copy_sync_output(ctx, result, fo, *, this_output_bytes, stage_t0, async_output=None, this_frames=0, frame_offset=0):
    if async_output is not None:
        if ctx.cfg.emit_first_pass_json and _env_flag('LOUDNORM_GPU_FIRST_PASS_OUTPUT_NATIVE', True):
            raise RuntimeError('native first-pass output metrics are not supported with async output')
        if async_output.double_buffer:
            async_output.queue_output(ctx.cuda, result, ctx.buffers, this_output_bytes=this_output_bytes)
            while len(async_output.pending) > 1:
                async_output.finish_pending(ctx.cuda, result, fo)
        else:
            async_output.finish_pending(ctx.cuda, result, fo)
            async_output.queue_output(ctx.cuda, result, ctx.buffers, this_output_bytes=this_output_bytes)
        result.apply_wall_time += time.perf_counter() - stage_t0
        return

    if getattr(fo, 'zero_copy', False):
        acquire_t0 = time.perf_counter()
        out_buf = fo.acquire_buffer(this_output_bytes)
        result.apply_write_time += time.perf_counter() - acquire_t0
        try:
            t0 = time.perf_counter()
            chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(out_buf[1]), ctx.buffers.d_out, this_output_bytes), 'cuMemcpyDtoH(output)')
            copy_dt = time.perf_counter() - t0
            result.apply_d2h_time += copy_dt
            result.total_d2h_time += copy_dt
            _capture_first_pass_output_metrics_native(ctx, result, out_buf[1], this_frames, frame_offset)
            result.apply_wall_time += time.perf_counter() - stage_t0
            write_t0 = time.perf_counter()
            fo.write_acquired(out_buf, this_output_bytes)
            result.apply_write_time += time.perf_counter() - write_t0
            out_buf = None
        finally:
            if out_buf is not None:
                fo.release_buffer(out_buf)
        return

    t0 = time.perf_counter()
    chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(ctx.host_io.host_out_ptr), ctx.buffers.d_out, this_output_bytes), 'cuMemcpyDtoH(output)')
    copy_dt = time.perf_counter() - t0
    result.apply_d2h_time += copy_dt
    result.total_d2h_time += copy_dt
    _capture_first_pass_output_metrics_native(ctx, result, ctx.host_io.host_out_ptr, this_frames, frame_offset)
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
    if _env_flag('LOUDNORM_GPU_FIRST_PASS_OUTPUT_NATIVE', True):
        ctx.native_first_pass_output_sums = init_native_output_sums(ctx)


def _safe_skip_chunk_bytes(ctx, state):
    cfg = ctx.cfg
    chunk_bytes = int(getattr(cfg, 'exact_safe_skip_chunk_bytes', 0) or 0)
    if chunk_bytes <= cfg.chunk_bytes:
        return None
    if not (
        cfg.exact_limiter_active
        and cfg.exact_sparse_chunks
        and cfg.exact_parallel_skip_safe_feedback
        and cfg.exact_skip_safe_feedback
        and not cfg.exact_profile_counts
        and not cfg.exact_use_prefilled_output
        and not cfg.source_exact_precompute
        and ctx.args.channels == 6
        and ctx.args.output_format == 'f64le'
        and state.frame_offset > 0
        and state.frame_offset < state.exact_prefinal_frames
        and (state.frame_offset % cfg.frames_per_window) == 0
    ):
        return None
    first_window = state.frame_offset // cfg.frames_per_window
    if ctx.prelimiter_unsafe_flags is None or first_window >= len(ctx.prelimiter_unsafe_flags):
        return None
    if ctx.prelimiter_unsafe_flags[first_window] != 0:
        return None
    feedback = feedback_state_i_view(state.feedback_state_i_host)
    if not (
        feedback.enabled('above_threshold')
        and not feedback.enabled('first')
        and feedback.get('out_window_count') == 0
        and not feedback.enabled('skip_safe_fill')
    ):
        return None
    return chunk_bytes


def _capture_first_pass_output_metrics(ctx, result, apply_chunk):
    if not ctx.cfg.emit_first_pass_json:
        return
    if _env_flag('LOUDNORM_GPU_FIRST_PASS_OUTPUT_NATIVE', True):
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
            try:
                if hasattr(fo, 'abort'):
                    fo.abort()
                else:
                    fo.close()
            except BrokenPipeError:
                pass
            if encode_proc is not None:
                encode_proc.kill()
                encode_proc.wait()
        else:
            try:
                finish_decode_pass(decode_proc, 'streaming decode pass 2')
            finally:
                finish_encode_pass(encode_proc, fo)


def open_sync_apply_state(ctx, result, *, force_prefetch=False):
    cuda = ctx.cuda
    args = ctx.args
    cfg = ctx.cfg
    exact_first_frame_length = cfg.frames_per_window * 30
    exact_final_flush_frames = max(0, exact_first_frame_length - cfg.frames_per_window)
    exact_use_final_flush = cfg.exact_limiter_active and cfg.total_frames > exact_first_frame_length and exact_final_flush_frames > 0 and cfg.total_frames > exact_final_flush_frames
    exact_prefinal_frames = cfg.total_frames - exact_final_flush_frames if exact_use_final_flush else cfg.total_frames
    feedback_state_i_host = new_feedback_state_i(prefilled_output=cfg.exact_use_prefilled_output)
    _reset_first_pass_output_metrics(ctx)
    encode_first = bool(
        cfg.streaming_io
        and cfg.encode_command
        and cfg.encode_command[0] == '__loudnorm_open_fifo_write__'
        and not _env_flag('LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DIRECT_FIFO_WRITE_DECODE_FIRST')
    )
    decode_proc = None
    encode_proc = None
    fi = None
    fo = None
    if encode_first:
        encode_proc, fo = start_encode_pass(args, cfg.streaming_io, cfg.encode_command)
        try:
            decode_proc, fi = start_decode_pass(args, cfg.streaming_io, cfg.decode_command, 'streaming decode pass 2')
        except BaseException:
            try:
                finish_encode_pass(encode_proc, fo)
            except BaseException:
                pass
            raise
    else:
        decode_proc, fi = start_decode_pass(args, cfg.streaming_io, cfg.decode_command, 'streaming decode pass 2')
        encode_proc, fo = start_encode_pass(args, cfg.streaming_io, cfg.encode_command)
    fo, async_writer = maybe_async_encode_writer(cfg.streaming_io, fo, chunk_bytes=cfg.output_chunk_bytes)
    async_output = None
    async_output_double_buffer = _env_flag('LOUDNORM_GPU_EXACT_APPLY_ASYNC_OUTPUT_DOUBLE_BUFFER')
    pinned_writer_output = _env_flag('LOUDNORM_GPU_EXACT_OUTPUT_PINNED_WRITER')
    async_output_requested = _env_flag('LOUDNORM_GPU_EXACT_APPLY_ASYNC_OUTPUT') or _env_flag('LOUDNORM_GPU_EXACT_APPLY_ASYNC_OUTPUT_DIRECT') or async_output_double_buffer or pinned_writer_output
    if async_output_requested and has_async_apply_api(cuda):
        try:
            async_output = ExactAsyncOutput(
                cuda,
                ctx.buffers,
                output_chunk_bytes=cfg.output_chunk_bytes,
                direct_device_output=_env_flag('LOUDNORM_GPU_EXACT_APPLY_ASYNC_OUTPUT_DIRECT') or async_output_double_buffer,
                double_buffer=async_output_double_buffer,
                pinned_writer=pinned_writer_output,
                pinned_writer_slots=_env_nonnegative_int('LOUDNORM_GPU_EXACT_OUTPUT_PINNED_WRITER_SLOTS', 4),
            )
        except Exception:
            async_output = None
    exact_prefetch_extra_chunks = _env_nonnegative_int('LOUDNORM_GPU_PAIR_FALLBACK_APPLY_PREFETCH_EXTRA_CHUNKS', 64) if force_prefetch else 2
    exact_stream_window = ExactLimiterStreamWindow(
        fi,
        ctx.host_io.host_in,
        frame_bytes=cfg.frame_bytes,
        chunk_bytes=cfg.chunk_bytes,
        apply_input_chunk_bytes=cfg.exact_apply_input_chunk_bytes,
        prefetch_enabled=True if force_prefetch else None,
        prefetch_extra_chunks=exact_prefetch_extra_chunks,
        limit_frames=cfg.total_frames if _env_flag('LOUDNORM_GPU_EXACT_STREAM_WINDOW_LIMIT_TOTAL_FRAMES') else None,
    ) if cfg.streaming_io and cfg.exact_limiter_active else None
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
    )


def run_sync_apply_step(ctx, result, state):
    cfg = ctx.cfg
    if not state.active or state.done_bytes >= cfg.nbytes:
        state.active = False
        return False
    if state.async_output is not None:
        state.async_output.select_output(ctx)
    apply_chunk = prepare_sync_apply_chunk(
        ctx,
        result,
        state.fi,
        state.exact_stream_window,
        done_bytes=state.done_bytes,
        frame_offset=state.frame_offset,
        exact_use_final_flush=state.exact_use_final_flush,
        exact_prefinal_frames=state.exact_prefinal_frames,
        exact_final_flush_frames=state.exact_final_flush_frames,
        exact_safe_skip_chunk_bytes=_safe_skip_chunk_bytes(ctx, state),
    )
    if apply_chunk is None:
        state.active = False
        return False
    stage_t0 = time.perf_counter()
    exact_chunk_unsafe, skip_safe_fill_chunk = classify_exact_chunk(
        ctx,
        result,
        frame_offset=state.frame_offset,
        this_frames=apply_chunk.this_frames,
        exact_run_end_frame=apply_chunk.exact_run_end_frame,
        exact_run_flag=apply_chunk.exact_run_flag,
    )

    _copy_sync_input(ctx, result, apply_chunk.copy_input_bytes)
    apply_exact_risk_gate(
        ctx,
        result,
        state.feedback_state_i_host,
        exact_chunk_unsafe,
        defer_copy=cfg.defer_safe_risk_gate_copy,
    )
    prefill_exact_output(
        ctx,
        result,
        state.feedback_state_i_host,
        frame_offset=state.frame_offset,
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
        state.feedback_state_i_host,
        exact_chunk_unsafe=exact_chunk_unsafe,
        frame_offset=state.frame_offset,
        exact_prefinal_frames=state.exact_prefinal_frames,
    )
    _capture_first_pass_output_metrics(ctx, result, apply_chunk)

    state.exact_transition_logged = refresh_exact_feedback_state(
        ctx,
        state.feedback_state_i_host,
        frame_offset=state.frame_offset,
        exact_transition_logged=state.exact_transition_logged,
    )
    _copy_sync_output(ctx, result, state.fo, this_output_bytes=apply_chunk.this_output_bytes, stage_t0=stage_t0, async_output=state.async_output, this_frames=apply_chunk.this_frames, frame_offset=state.frame_offset)
    state.done_bytes += apply_chunk.this_bytes
    state.frame_offset += apply_chunk.this_frames
    ctx.emit_progress('apply', 0.75 + 0.25 * (state.done_bytes / float(cfg.nbytes)))
    if state.done_bytes >= cfg.nbytes:
        state.active = False
    return True


def close_sync_apply_state(ctx, result, state):
    cuda = ctx.cuda
    cfg = ctx.cfg
    if state.async_output is not None:
        try:
            if sys.exc_info()[0] is None:
                state.async_output.finish_pending(cuda, result, state.fo, drain=True)
        finally:
            state.async_output.cleanup(cuda)
    if state.exact_stream_window is not None:
        state.exact_stream_window.close()
    _close_sync_streams(state.decode_proc, state.fi, state.encode_proc, state.fo)
    if state.async_writer is not None:
        result.apply_async_write = 1
        result.apply_async_write_worker_time += state.async_writer.worker_write_time
        result.apply_async_write_close_wait_time += state.async_writer.close_wait_time
        result.apply_async_write_peak_queue = max(result.apply_async_write_peak_queue, state.async_writer.peak_queue)
        result.apply_async_write_borrowed_writes += getattr(state.async_writer, 'borrowed_writes', 0)
        result.apply_async_write_borrowed_bytes += getattr(state.async_writer, 'borrowed_bytes', 0)
    if state.async_output is not None:
        result.apply_async_output_borrow_wait_time += getattr(state.async_output, 'borrow_wait_time', 0.0)
        result.apply_async_output_borrowed_writes += getattr(state.async_output, 'borrowed_writes', 0)
        result.apply_async_output_borrowed_bytes += getattr(state.async_output, 'borrowed_bytes', 0)
        result.apply_async_output_borrowed_peak_slots = max(
            result.apply_async_output_borrowed_peak_slots,
            getattr(state.async_output, 'borrowed_peak_slots', 0),
        )

    if cfg.exact_limiter_active and cfg.exact_profile_counts:
        result.exact_counts_host = array.array('d', [0.0]) * 128
        chk(cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(result.exact_counts_host.buffer_info()[0]), ctx.buffers.d_feedback_state_d, 128 * 8), 'cuMemcpyDtoH(exact profile counts)')


def _close_paired_sync_apply_states(primary_ctx, primary_result, primary_state, partner_ctx, partner_result, partner_state):
    if (
        not _env_flag('LOUDNORM_GPU_PAIR_FALLBACK_APPLY_PARALLEL_CLOSE', True)
        or sys.exc_info()[0] is not None
        or primary_ctx.cfg.exact_profile_counts
        or partner_ctx.cfg.exact_profile_counts
    ):
        close_sync_apply_state(primary_ctx, primary_result, primary_state)
        close_sync_apply_state(partner_ctx, partner_result, partner_state)
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


def run_sync_apply(ctx, result):
    state = open_sync_apply_state(ctx, result)
    try:
        while run_sync_apply_step(ctx, result, state):
            pass
    finally:
        close_sync_apply_state(ctx, result, state)


def run_paired_sync_apply(primary_ctx, primary_result, partner_ctx, partner_result):
    primary_state = open_sync_apply_state(primary_ctx, primary_result, force_prefetch=True)
    partner_state = open_sync_apply_state(partner_ctx, partner_result, force_prefetch=True)
    try:
        while primary_state.active or partner_state.active:
            candidates = []
            if primary_state.active:
                primary_progress = primary_state.done_bytes / float(primary_ctx.cfg.nbytes) if primary_ctx.cfg.nbytes else 1.0
                candidates.append((primary_progress, primary_ctx, primary_result, primary_state))
            if partner_state.active:
                partner_progress = partner_state.done_bytes / float(partner_ctx.cfg.nbytes) if partner_ctx.cfg.nbytes else 1.0
                candidates.append((partner_progress, partner_ctx, partner_result, partner_state))
            if not candidates:
                break
            _, ctx, result, state = min(candidates, key=lambda item: item[0])
            if not run_sync_apply_step(ctx, result, state):
                break
    finally:
        _close_paired_sync_apply_states(primary_ctx, primary_result, primary_state, partner_ctx, partner_result, partner_state)
