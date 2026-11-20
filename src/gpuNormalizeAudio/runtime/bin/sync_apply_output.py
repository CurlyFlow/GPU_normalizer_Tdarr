import ctypes
import threading
import time

from cuda_driver import alloc_pinned_host_buffer, chk
from device_slot_export import device_slot_output_only_enabled, maybe_export_device_slot
from first_pass_output_metrics import inline_first_pass_output_sums, inline_output_sums_native_audit, native_first_pass_output_sums
from first_pass_output_native import capture_first_pass_output_metrics_native


class ExactAsyncOutput:
    def __init__(self, cuda, buffers, *, output_chunk_bytes, direct_device_output=False, double_buffer=False, pinned_writer=False, pinned_writer_slots=0, event_writer=False, event_writer_slots=0, cuda_context=None):
        self.streams = []
        self.pinned_ptrs = []
        self.pinned_raws = []
        self.pinned_views = []
        self.extra_device_outputs = []
        self.pending = []
        self.current_slot = None
        self.event_writer = bool(event_writer)
        self.cuda_context = cuda_context
        self.direct_device_output = bool(direct_device_output or self.event_writer)
        self.double_buffer = bool((double_buffer or self.event_writer) and self.direct_device_output)
        self.pinned_writer = bool(pinned_writer or self.event_writer)
        self.borrowed_host_slots = set()
        self.borrow_condition = threading.Condition()
        self.borrow_wait_time = 0.0
        self.borrowed_writes = 0
        self.borrowed_bytes = 0
        self.borrowed_peak_slots = 0
        host_slots = 2 if self.double_buffer else 1
        if self.pinned_writer:
            host_slots = max(host_slots, max(2, int(pinned_writer_slots or 0)))
        if self.event_writer:
            host_slots = max(host_slots, max(2, int(event_writer_slots or 0)))
        for slot in range(host_slots):
            stream = ctypes.c_void_p()
            label = f'exact async output {slot}' if host_slots > 1 else 'exact async output'
            chk(cuda.cuStreamCreate(ctypes.byref(stream), 0), f'cuStreamCreate({label})')
            pinned_ptr, pinned_raw, pinned_view = alloc_pinned_host_buffer(cuda, output_chunk_bytes, label)
            self.streams.append(stream)
            self.pinned_ptrs.append(pinned_ptr)
            self.pinned_raws.append(pinned_raw)
            self.pinned_views.append(pinned_view)
        if not getattr(buffers.d_apply_out_b, 'value', 0):
            chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_apply_out_b), output_chunk_bytes), 'cuMemAlloc(exact async output b)')
        self.device_outputs = [buffers.d_out, buffers.d_apply_out_b]
        while self.event_writer and len(self.device_outputs) < host_slots:
            ptr = ctypes.c_void_p()
            chk(cuda.cuMemAlloc_v2(ctypes.byref(ptr), output_chunk_bytes), f'cuMemAlloc(exact async output event slot {len(self.device_outputs)})')
            self.extra_device_outputs.append(ptr)
            self.device_outputs.append(ptr)
        self.device_output_args = [ctypes.c_uint64(buffers.d_out.value), ctypes.c_uint64(buffers.d_apply_out_b.value)]
        self.device_output_args.extend(ctypes.c_uint64(ptr.value) for ptr in self.extra_device_outputs)

    def select_output(self, ctx):
        if not self.direct_device_output:
            return
        wait_t0 = None
        with self.borrow_condition:
            while True:
                pending_slots = {record['device_slot'] for record in self.pending}
                slot = next((idx for idx in range(len(self.device_outputs)) if idx not in pending_slots), None)
                if slot is not None:
                    if wait_t0 is not None:
                        self.borrow_wait_time += time.perf_counter() - wait_t0
                    break
                if not self.event_writer:
                    raise RuntimeError('no free exact async direct output slot')
                if wait_t0 is None:
                    wait_t0 = time.perf_counter()
                self.borrow_condition.wait(timeout=0.05)
        self.current_slot = slot
        ctx.bindings.out_arg = self.device_output_args[slot]
        if hasattr(ctx, '_safe_feedback_apply6_arg_cache'):
            delattr(ctx, '_safe_feedback_apply6_arg_cache')

    def finish_pending(self, cuda, result, fo, *, drain=False):
        if self.event_writer:
            if drain:
                self.wait_borrowed()
            return
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

    def _release_event_record(self, record):
        released = False

        def release():
            nonlocal released
            with self.borrow_condition:
                if released:
                    return
                released = True
                try:
                    self.pending.remove(record)
                except ValueError:
                    pass
                self.borrow_condition.notify_all()

        return release

    def wait_borrowed(self):
        wait_t0 = None
        with self.borrow_condition:
            while self.borrowed_host_slots or (self.event_writer and self.pending):
                if wait_t0 is None:
                    wait_t0 = time.perf_counter()
                self.borrow_condition.wait(timeout=0.05)
            if wait_t0 is not None:
                self.borrow_wait_time += time.perf_counter() - wait_t0

    def queue_output(self, cuda, result, buffers, fo, *, this_output_bytes):
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
        event = None
        if self.event_writer:
            event = ctypes.c_void_p()
            chk(cuda.cuEventCreate(ctypes.byref(event), 0), 'cuEventCreate(exact output event writer)')
            chk(cuda.cuEventRecord(event, stream), 'cuEventRecord(exact output event writer)')
        result.apply_d2h_time += time.perf_counter() - t0
        record = {
            'bytes': this_output_bytes,
            'device_slot': device_slot,
            'host_slot': host_slot,
            'stream': stream,
            'view': pinned_view,
        }
        self.pending.append(record)
        if self.event_writer:
            if not hasattr(fo, 'write_cuda_event_borrowed'):
                self.pending.remove(record)
                if event is not None and event.value:
                    cuda.cuEventDestroy_v2(event)
                raise RuntimeError('async encode writer does not support CUDA event output')
            release = self._release_event_record(record)
            write_t0 = time.perf_counter()
            try:
                fo.write_cuda_event_borrowed(cuda, self.cuda_context, event, pinned_view[:this_output_bytes], release)
            except BaseException:
                release()
                if event is not None and event.value:
                    cuda.cuEventDestroy_v2(event)
                raise
            self.borrowed_writes += 1
            self.borrowed_bytes += this_output_bytes
            self.borrowed_peak_slots = max(self.borrowed_peak_slots, len(self.pending))
            result.apply_write_time += time.perf_counter() - write_t0

    def cleanup(self, cuda, *, wait=True):
        if wait:
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
        for ptr in self.extra_device_outputs:
            if ptr.value:
                cuda.cuMemFree_v2(ptr)
        self.extra_device_outputs = []


class SyncPinnedBorrowedOutput:
    def __init__(self, cuda, output_chunk_bytes, slot_limit):
        self.cuda = cuda
        self.output_chunk_bytes = output_chunk_bytes
        self.slot_limit = max(1, int(slot_limit or 0))
        self.pinned_ptrs = []
        self.pinned_raws = []
        self.pinned_views = []
        self.free_slots = []
        self.borrowed_slots = set()
        self.borrow_condition = threading.Condition()
        self.borrow_wait_time = 0.0
        self.borrowed_writes = 0
        self.borrowed_bytes = 0
        self.borrowed_peak_slots = 0

    def _allocate_slot_locked(self):
        slot = len(self.pinned_ptrs)
        ptr, raw, view = alloc_pinned_host_buffer(self.cuda, self.output_chunk_bytes, f'sync borrowed output {slot}')
        self.pinned_ptrs.append(ptr)
        self.pinned_raws.append(raw)
        self.pinned_views.append(view)
        return slot

    def acquire(self):
        wait_t0 = None
        with self.borrow_condition:
            while True:
                if self.free_slots:
                    slot = self.free_slots.pop()
                    break
                if len(self.pinned_ptrs) < self.slot_limit:
                    slot = self._allocate_slot_locked()
                    break
                if wait_t0 is None:
                    wait_t0 = time.perf_counter()
                self.borrow_condition.wait(timeout=0.05)
            if wait_t0 is not None:
                self.borrow_wait_time += time.perf_counter() - wait_t0
            self.borrowed_slots.add(slot)
            self.borrowed_peak_slots = max(self.borrowed_peak_slots, len(self.borrowed_slots))
        return slot, self.pinned_ptrs[slot], self.pinned_views[slot], self._release_slot(slot)

    def _release_slot(self, slot):
        released = False

        def release():
            nonlocal released
            with self.borrow_condition:
                if released:
                    return
                released = True
                self.borrowed_slots.discard(slot)
                self.free_slots.append(slot)
                self.borrow_condition.notify_all()

        return release

    def wait_borrowed(self):
        wait_t0 = None
        with self.borrow_condition:
            while self.borrowed_slots:
                if wait_t0 is None:
                    wait_t0 = time.perf_counter()
                self.borrow_condition.wait(timeout=0.05)
            if wait_t0 is not None:
                self.borrow_wait_time += time.perf_counter() - wait_t0

    def cleanup(self, cuda, *, wait=True):
        if wait:
            self.wait_borrowed()
        elif self.borrowed_slots:
            return
        for ptr in self.pinned_ptrs:
            if ptr.value:
                cuda.cuMemFreeHost(ptr)
        self.pinned_ptrs = []
        self.pinned_raws = []
        self.pinned_views = []


def copy_sync_output(ctx, result, fo, *, this_output_bytes, stage_t0, async_output=None, borrowed_output=None, this_frames=0, frame_offset=0):
    maybe_export_device_slot(
        ctx,
        this_output_bytes=this_output_bytes,
        this_frames=this_frames,
        frame_offset=frame_offset,
    )
    if device_slot_output_only_enabled():
        result.apply_wall_time += time.perf_counter() - stage_t0
        return
    if inline_first_pass_output_sums(ctx) and getattr(fo, 'loudnorm_null_write', False):
        if inline_output_sums_native_audit(ctx):
            t0 = time.perf_counter()
            chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(ctx.host_io.host_out_ptr), ctypes.c_void_p(ctx.bindings.out_arg.value), this_output_bytes), 'cuMemcpyDtoH(output inline audit)')
            copy_dt = time.perf_counter() - t0
            result.apply_d2h_time += copy_dt
            result.total_d2h_time += copy_dt
            capture_first_pass_output_metrics_native(ctx, result, ctx.host_io.host_out_ptr, this_frames, frame_offset)
        result.apply_wall_time += time.perf_counter() - stage_t0
        return

    if async_output is not None:
        if native_first_pass_output_sums(ctx):
            raise RuntimeError('native first-pass output metrics are not supported with async output')
        if async_output.double_buffer:
            async_output.queue_output(ctx.cuda, result, ctx.buffers, fo, this_output_bytes=this_output_bytes)
            while len(async_output.pending) > 1:
                async_output.finish_pending(ctx.cuda, result, fo)
        else:
            async_output.finish_pending(ctx.cuda, result, fo)
            async_output.queue_output(ctx.cuda, result, ctx.buffers, fo, this_output_bytes=this_output_bytes)
        result.apply_wall_time += time.perf_counter() - stage_t0
        return

    if getattr(fo, 'zero_copy', False):
        acquire_t0 = time.perf_counter()
        out_buf = fo.acquire_buffer(this_output_bytes)
        result.apply_write_time += time.perf_counter() - acquire_t0
        try:
            t0 = time.perf_counter()
            chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(out_buf[1]), ctypes.c_void_p(ctx.bindings.out_arg.value), this_output_bytes), 'cuMemcpyDtoH(output)')
            copy_dt = time.perf_counter() - t0
            result.apply_d2h_time += copy_dt
            result.total_d2h_time += copy_dt
            capture_first_pass_output_metrics_native(ctx, result, out_buf[1], this_frames, frame_offset)
            result.apply_wall_time += time.perf_counter() - stage_t0
            write_t0 = time.perf_counter()
            fo.write_acquired(out_buf, this_output_bytes)
            result.apply_write_time += time.perf_counter() - write_t0
            out_buf = None
        finally:
            if out_buf is not None:
                fo.release_buffer(out_buf)
        return

    if borrowed_output is not None:
        slot, out_ptr, out_view, release = borrowed_output.acquire()
        try:
            t0 = time.perf_counter()
            chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(out_ptr.value), ctypes.c_void_p(ctx.bindings.out_arg.value), this_output_bytes), 'cuMemcpyDtoH(output borrowed)')
            copy_dt = time.perf_counter() - t0
            result.apply_d2h_time += copy_dt
            result.total_d2h_time += copy_dt
            capture_first_pass_output_metrics_native(ctx, result, out_ptr.value, this_frames, frame_offset)
            result.apply_wall_time += time.perf_counter() - stage_t0
            write_t0 = time.perf_counter()
            fo.write_borrowed(out_view[:this_output_bytes], release)
            release = None
            borrowed_output.borrowed_writes += 1
            borrowed_output.borrowed_bytes += this_output_bytes
            result.apply_write_time += time.perf_counter() - write_t0
        finally:
            if release is not None:
                release()
        return

    t0 = time.perf_counter()
    chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(ctx.host_io.host_out_ptr), ctypes.c_void_p(ctx.bindings.out_arg.value), this_output_bytes), 'cuMemcpyDtoH(output)')
    copy_dt = time.perf_counter() - t0
    result.apply_d2h_time += copy_dt
    result.total_d2h_time += copy_dt
    capture_first_pass_output_metrics_native(ctx, result, ctx.host_io.host_out_ptr, this_frames, frame_offset)
    result.apply_wall_time += time.perf_counter() - stage_t0
    if getattr(fo, 'loudnorm_null_write', False):
        return
    out_view = memoryview(ctx.host_io.host_out)[:this_output_bytes]
    write_t0 = time.perf_counter()
    fo.write(out_view)
    result.apply_write_time += time.perf_counter() - write_t0
