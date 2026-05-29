from __future__ import annotations

import ctypes
from dataclasses import dataclass
import os
import queue
import subprocess
import sys
import threading
import time


def env_flag(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value in ('1', 'true', 'TRUE', 'yes', 'YES')


def env_int(name, default):
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return max(1, int(value))
    except ValueError:
        return default


def env_bytes_mib(name, default_mib):
    value = os.environ.get(name)
    if value is None:
        return int(default_mib * 1024 * 1024)
    try:
        return max(1, int(float(value) * 1024 * 1024))
    except ValueError:
        return int(default_mib * 1024 * 1024)


_PY_BYTES_AS_STRING = ctypes.pythonapi.PyBytes_AsString
_PY_BYTES_AS_STRING.argtypes = (ctypes.py_object,)
_PY_BYTES_AS_STRING.restype = ctypes.c_void_p


def _bytes_data_ptr(data):
    ptr = _PY_BYTES_AS_STRING(data)
    if not ptr:
        raise RuntimeError('failed to get bytes payload pointer')
    return int(ptr)


def start_decode_pass(args, streaming_io, decode_command, label):
    if not streaming_io:
        return None, open(args.input_f32, 'rb')
    if decode_command and decode_command[0] == '__loudnorm_open_fifo__':
        if len(decode_command) != 2:
            raise RuntimeError(f'{label} direct FIFO decode command is invalid')
        return None, open(decode_command[1], 'rb', buffering=0)
    if decode_command and decode_command[0] == '__loudnorm_stdin__':
        if len(decode_command) != 1:
            raise RuntimeError(f'{label} stdin decode command is invalid')
        return None, sys.stdin.buffer
    popen_kwargs = {}
    pipe_mib = os.environ.get('LOUDNORM_GPU_DECODE_PIPE_MIB')
    if pipe_mib:
        try:
            popen_kwargs['pipesize'] = max(1, int(float(pipe_mib) * 1024 * 1024))
        except ValueError:
            pass
    try:
        proc = subprocess.Popen(decode_command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=sys.stderr, **popen_kwargs)
    except (OSError, TypeError, PermissionError):
        proc = subprocess.Popen(decode_command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=sys.stderr)
    if proc.stdout is None:
        raise RuntimeError(f'{label} failed to open decode stdout')
    return proc, proc.stdout


def finish_decode_pass(proc, label):
    if proc is None:
        return
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f'{label} failed with exit code {code}')


def start_encode_pass(args, streaming_io, encode_command):
    if not streaming_io:
        return None, open(args.output_f32, 'wb')
    if encode_command and encode_command[0] == '__loudnorm_open_fifo_write__':
        if len(encode_command) != 2:
            raise RuntimeError('encode direct FIFO write command is invalid')
        return None, open(encode_command[1], 'wb')
    popen_kwargs = {}
    pipe_mib = os.environ.get('LOUDNORM_GPU_ENCODE_PIPE_MIB')
    if pipe_mib:
        try:
            popen_kwargs['pipesize'] = max(1, int(float(pipe_mib) * 1024 * 1024))
        except ValueError:
            pass
    try:
        proc = subprocess.Popen(encode_command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=sys.stderr, **popen_kwargs)
    except (OSError, TypeError, PermissionError):
        proc = subprocess.Popen(encode_command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=sys.stderr)
    if proc.stdin is None:
        raise RuntimeError('encode failed to open stdin')
    return proc, proc.stdin


class AsyncEncodeWriter:
    def __init__(self, handle, *, max_items, zero_copy=False, buffer_bytes=0, pool_items=None, writev=False, writev_max_bytes=0, writev_max_items=0):
        self.handle = handle
        self.zero_copy = bool(zero_copy)
        self.writev = bool(writev)
        self.writev_max_bytes = max(1, int(writev_max_bytes)) if self.writev else 0
        self.writev_max_items = max(1, int(writev_max_items)) if self.writev else 0
        self.writev_iov_max = 1024
        if self.writev and hasattr(os, 'sysconf'):
            try:
                self.writev_iov_max = max(1, int(os.sysconf('SC_IOV_MAX')))
            except (OSError, ValueError):
                self.writev_iov_max = 1024
        self.fd = handle.fileno() if self.writev else None
        queue_items = max(1, int(pool_items if pool_items is not None else max_items))
        self.queue = queue.Queue(maxsize=queue_items)
        self.free_buffers = queue.Queue(maxsize=queue_items) if self.zero_copy else None
        if self.zero_copy:
            alloc_bytes = max(1, int(buffer_bytes))
            for _ in range(queue_items):
                buf = bytearray(alloc_bytes)
                ptr = ctypes.addressof(ctypes.c_char.from_buffer(buf))
                self.free_buffers.put((buf, ptr))
        self.closed = False
        self.aborted = False
        self.error = None
        self.worker_write_time = 0.0
        self.close_wait_time = 0.0
        self.peak_queue = 0
        self.thread = threading.Thread(target=self._worker, name='async encode writer', daemon=True)
        self.thread.start()

    def _item_payload(self, item):
        if self.zero_copy:
            buf_info, size = item
            return memoryview(buf_info[0])[:size], buf_info
        return memoryview(item), None

    def _writev_all(self, payloads):
        views = [payload for payload in payloads if len(payload) > 0]
        while views:
            wrote = os.writev(self.fd, views[:self.writev_iov_max])
            if wrote <= 0:
                raise BrokenPipeError('encode pipe writev wrote no bytes')
            remaining = wrote
            while views and remaining >= len(views[0]):
                remaining -= len(views[0])
                views.pop(0)
            if views and remaining > 0:
                views[0] = views[0][remaining:]

    def _writev_batch(self, first_item):
        batch = [first_item]
        batch_bytes, batch_items = self._item_size(first_item), 1
        stop_after_batch = False
        while batch_items < self.writev_max_items and batch_bytes < self.writev_max_bytes:
            try:
                item = self.queue.get_nowait()
            except queue.Empty:
                break
            if item is None:
                stop_after_batch = True
                break
            if self.aborted:
                if self.zero_copy:
                    self.free_buffers.put(item[0])
                continue
            batch.append(item)
            batch_bytes += self._item_size(item)
            batch_items += 1

        payloads = []
        zero_copy_buffers = []
        try:
            for item in batch:
                payload, buf_info = self._item_payload(item)
                payloads.append(payload)
                if buf_info is not None:
                    zero_copy_buffers.append(buf_info)
            t0 = time.perf_counter()
            self._writev_all(payloads)
            self.worker_write_time += time.perf_counter() - t0
        finally:
            for buf_info in zero_copy_buffers:
                self.free_buffers.put(buf_info)
        return stop_after_batch

    def _item_size(self, item):
        if self.zero_copy:
            return int(item[1])
        return len(item)

    def _worker(self):
        try:
            while True:
                item = self.queue.get()
                if item is None:
                    return
                if self.aborted:
                    if self.zero_copy:
                        self.free_buffers.put(item[0])
                    continue
                if self.writev:
                    if self._writev_batch(item):
                        return
                    continue
                if self.zero_copy:
                    buf_info, size = item
                    payload = memoryview(buf_info[0])[:size]
                else:
                    payload = item
                t0 = time.perf_counter()
                self.handle.write(payload)
                self.worker_write_time += time.perf_counter() - t0
                if self.zero_copy:
                    self.free_buffers.put(buf_info)
        except BaseException as exc:
            self.error = exc

    def acquire_buffer(self, size):
        if not self.zero_copy:
            raise RuntimeError('async encode writer is not in zero-copy mode')
        if self.closed:
            raise ValueError('async encode writer is closed')
        buf_info = self.free_buffers.get()
        if len(buf_info[0]) < size:
            self.free_buffers.put(buf_info)
            raise RuntimeError(f'zero-copy encode buffer too small: have={len(buf_info[0])} need={size}')
        return buf_info

    def release_buffer(self, buf_info):
        if self.zero_copy and buf_info is not None:
            self.free_buffers.put(buf_info)

    def write_acquired(self, buf_info, size):
        if self.closed:
            self.release_buffer(buf_info)
            raise ValueError('async encode writer is closed')
        self.queue.put((buf_info, size))
        self.peak_queue = max(self.peak_queue, self.queue.qsize())

    def write(self, data):
        if self.closed:
            raise ValueError('async encode writer is closed')
        payload = bytes(data)
        self.queue.put(payload)
        self.peak_queue = max(self.peak_queue, self.queue.qsize())

    def close(self):
        if self.closed:
            return
        self.closed = True
        t0 = time.perf_counter()
        self.queue.put(None)
        self.thread.join()
        self.close_wait_time += time.perf_counter() - t0
        try:
            self.handle.close()
        except BrokenPipeError:
            pass
        if self.error is not None:
            raise self.error

    def abort(self):
        self.aborted = True
        if self.closed:
            return
        self.closed = True
        try:
            self.handle.close()
        except BrokenPipeError:
            pass
        try:
            self.queue.put_nowait(None)
        except queue.Full:
            pass
        self.thread.join(timeout=5.0)


def maybe_async_encode_writer(streaming_io, handle, *, chunk_bytes):
    if not streaming_io or not env_flag('LOUDNORM_GPU_ASYNC_ENCODE_WRITE', True):
        return handle, None
    max_items = env_int('LOUDNORM_GPU_ASYNC_ENCODE_WRITE_QUEUE', 1024)
    max_bytes = env_bytes_mib('LOUDNORM_GPU_ASYNC_ENCODE_WRITE_MAX_MIB', 1024)
    byte_limited_items = max(1, max_bytes // max(1, chunk_bytes))
    effective_items = min(max_items, byte_limited_items)
    zero_copy = env_flag('LOUDNORM_GPU_ZERO_COPY_ENCODE_WRITE', False)
    pool_items = env_int('LOUDNORM_GPU_ZERO_COPY_ENCODE_WRITE_POOL', min(effective_items, 32)) if zero_copy else None
    if pool_items is not None:
        pool_items = min(effective_items, pool_items)
    writev = env_flag('LOUDNORM_GPU_ASYNC_ENCODE_WRITEV', False)
    writev_max_bytes = env_bytes_mib('LOUDNORM_GPU_ASYNC_ENCODE_WRITEV_MAX_MIB', 8) if writev else 0
    writev_max_items = env_int('LOUDNORM_GPU_ASYNC_ENCODE_WRITEV_MAX_ITEMS', 64) if writev else 0
    writer = AsyncEncodeWriter(
        handle,
        max_items=effective_items,
        zero_copy=zero_copy,
        buffer_bytes=chunk_bytes,
        pool_items=pool_items,
        writev=writev,
        writev_max_bytes=writev_max_bytes,
        writev_max_items=writev_max_items,
    )
    return writer, writer


def finish_encode_pass(proc, handle):
    if proc is None:
        try:
            handle.close()
        except BrokenPipeError:
            pass
        return
    try:
        handle.close()
    except BrokenPipeError:
        pass
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f'encode failed with exit code {code}')


def close_decode_pass(proc, handle, label):
    exc_active = sys.exc_info()[0] is not None
    handle.close()
    if exc_active and proc is not None:
        proc.kill()
        proc.wait()
    else:
        finish_decode_pass(proc, label)


@dataclass
class FrameChunk:
    this_bytes: int
    this_frames: int
    done_bytes: int
    frame_offset: int
    payload: object = None
    payload_ptr: int = 0


class FrameChunkReader:
    def __init__(self, args, streaming_io, decode_command, label, host_buffer, *, nbytes, chunk_bytes, frame_bytes, partial_frame_error, staging_label, short_read_error, alignment_error='chunk is not frame-aligned', limit_kind='capacity', limit_label=None, direct_payload=False, direct_bytearray_payload=False):
        self.args = args
        self.streaming_io = streaming_io
        self.decode_command = decode_command
        self.label = label
        self.host_buffer = host_buffer
        self.nbytes = nbytes
        self.chunk_bytes = chunk_bytes
        self.frame_bytes = frame_bytes
        self.partial_frame_error = partial_frame_error
        self.staging_label = staging_label
        self.short_read_error = short_read_error
        self.alignment_error = alignment_error
        self.limit_kind = limit_kind
        self.limit_label = limit_label or staging_label
        self.direct_payload = bool(direct_payload)
        self.direct_bytearray_payload = bool(direct_bytearray_payload)
        self.proc = None
        self.handle = None
        self.done_bytes = 0
        self.frame_offset = 0
        self.prefetch_enabled = False
        self.prefetch_queue = None
        self.prefetch_buffer_pool = None
        self.prefetch_stop = None
        self.prefetch_thread = None
        self.prefetch_aligned_fastpath = False

    def __enter__(self):
        self.proc, self.handle = start_decode_pass(self.args, self.streaming_io, self.decode_command, self.label)
        self.prefetch_enabled = bool(self.streaming_io and env_flag('LOUDNORM_GPU_PREFETCH_DECODE', True))
        if self.prefetch_enabled:
            max_items = env_int('LOUDNORM_GPU_PREFETCH_DECODE_QUEUE', 32)
            max_bytes = env_bytes_mib('LOUDNORM_GPU_PREFETCH_DECODE_MAX_MIB', 512)
            byte_limited_items = max(1, max_bytes // max(1, self.chunk_bytes))
            queue_items = max(1, min(max_items, byte_limited_items))
            self.prefetch_queue = queue.Queue(maxsize=queue_items)
            if self.direct_bytearray_payload:
                self.prefetch_buffer_pool = queue.Queue(maxsize=queue_items)
                for _ in range(queue_items):
                    self.prefetch_buffer_pool.put(bytearray(self.chunk_bytes))
            self.prefetch_stop = threading.Event()
            self.prefetch_thread = threading.Thread(target=self._prefetch_worker, name=f'{self.label} prefetch', daemon=True)
            self.prefetch_aligned_fastpath = env_flag('LOUDNORM_GPU_PREFETCH_ALIGNED_FASTPATH')
            self.prefetch_thread.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        if self.prefetch_enabled and self.prefetch_stop is not None:
            self.prefetch_stop.set()
            if exc_type is not None and self.proc is not None:
                self.proc.kill()
            if self.prefetch_thread is not None:
                self.prefetch_thread.join(timeout=5.0)
        close_decode_pass(self.proc, self.handle, self.label)

    def __iter__(self):
        if self.prefetch_enabled:
            yield from self._iter_prefetch()
            return
        stream_tail = bytearray()
        host_view = memoryview(self.host_buffer)
        while True:
            if self.streaming_io:
                data = self.handle.read(max(1, self.chunk_bytes - len(stream_tail)))
                if not data:
                    if stream_tail:
                        raise RuntimeError(self.partial_frame_error)
                    break
                if self.prefetch_aligned_fastpath and not stream_tail and (len(data) % self.frame_bytes) == 0:
                    this_bytes = len(data)
                    if this_bytes > len(self.host_buffer):
                        raise RuntimeError(f'{self.staging_label} exceeded: need={this_bytes} capacity={len(self.host_buffer)}')
                    if done_bytes + this_bytes > self.nbytes:
                        if self.limit_kind == 'expected':
                            raise RuntimeError(f'{self.limit_label} exceeded first pass length: bytes={done_bytes + this_bytes} expected={self.nbytes}')
                        raise RuntimeError(f'streaming input exceeded allocation estimate: bytes={done_bytes + this_bytes} capacity={self.nbytes}')
                    self._queue_put(('chunk', data, done_bytes, frame_offset))
                    done_bytes += this_bytes
                    frame_offset += this_bytes // self.frame_bytes
                    continue
                stream_tail.extend(data)
                this_bytes = len(stream_tail) - (len(stream_tail) % self.frame_bytes)
                if this_bytes <= 0:
                    continue
                if this_bytes > len(self.host_buffer):
                    raise RuntimeError(f'{self.staging_label} exceeded: need={this_bytes} capacity={len(self.host_buffer)}')
                if self.done_bytes + this_bytes > self.nbytes:
                    if self.limit_kind == 'expected':
                        raise RuntimeError(f'{self.limit_label} exceeded first pass length: bytes={self.done_bytes + this_bytes} expected={self.nbytes}')
                    raise RuntimeError(f'streaming input exceeded allocation estimate: bytes={self.done_bytes + this_bytes} capacity={self.nbytes}')
                host_view[:this_bytes] = stream_tail[:this_bytes]
                del stream_tail[:this_bytes]
            else:
                if self.done_bytes >= self.nbytes:
                    break
                this_bytes = min(self.chunk_bytes, self.nbytes - self.done_bytes)
                if this_bytes % self.frame_bytes:
                    raise RuntimeError(self.alignment_error)
                got = self.handle.readinto(host_view[:this_bytes])
                if got != this_bytes:
                    raise RuntimeError(self.short_read_error)
            if this_bytes % self.frame_bytes:
                raise RuntimeError(self.alignment_error)
            this_frames = this_bytes // self.frame_bytes
            chunk = FrameChunk(
                this_bytes=this_bytes,
                this_frames=this_frames,
                done_bytes=self.done_bytes,
                frame_offset=self.frame_offset,
            )
            self.done_bytes += this_bytes
            self.frame_offset += this_frames
            yield chunk

    def _queue_put(self, item):
        while self.prefetch_stop is not None and not self.prefetch_stop.is_set():
            try:
                self.prefetch_queue.put(item, timeout=0.1)
                return
            except queue.Full:
                continue

    def _prefetch_worker(self):
        if self.direct_bytearray_payload:
            self._prefetch_worker_bytearray()
            return
        stream_tail = bytearray()
        done_bytes = 0
        frame_offset = 0
        try:
            while self.prefetch_stop is not None and not self.prefetch_stop.is_set():
                data = self.handle.read(max(1, self.chunk_bytes - len(stream_tail)))
                if not data:
                    if stream_tail:
                        raise RuntimeError(self.partial_frame_error)
                    break
                this_bytes = len(data)
                if self.prefetch_aligned_fastpath and not stream_tail and (this_bytes % self.frame_bytes) == 0:
                    if this_bytes > len(self.host_buffer):
                        raise RuntimeError(f'{self.staging_label} exceeded: need={this_bytes} capacity={len(self.host_buffer)}')
                    if done_bytes + this_bytes > self.nbytes:
                        if self.limit_kind == 'expected':
                            raise RuntimeError(f'{self.limit_label} exceeded first pass length: bytes={done_bytes + this_bytes} expected={self.nbytes}')
                        raise RuntimeError(f'streaming input exceeded allocation estimate: bytes={done_bytes + this_bytes} capacity={self.nbytes}')
                    self._queue_put(('chunk', data, done_bytes, frame_offset))
                    done_bytes += this_bytes
                    frame_offset += this_bytes // self.frame_bytes
                    continue
                stream_tail.extend(data)
                this_bytes = len(stream_tail) - (len(stream_tail) % self.frame_bytes)
                if this_bytes <= 0:
                    continue
                if this_bytes > len(self.host_buffer):
                    raise RuntimeError(f'{self.staging_label} exceeded: need={this_bytes} capacity={len(self.host_buffer)}')
                if done_bytes + this_bytes > self.nbytes:
                    if self.limit_kind == 'expected':
                        raise RuntimeError(f'{self.limit_label} exceeded first pass length: bytes={done_bytes + this_bytes} expected={self.nbytes}')
                    raise RuntimeError(f'streaming input exceeded allocation estimate: bytes={done_bytes + this_bytes} capacity={self.nbytes}')
                payload = bytes(memoryview(stream_tail)[:this_bytes])
                del stream_tail[:this_bytes]
                self._queue_put(('chunk', payload, done_bytes, frame_offset))
                done_bytes += this_bytes
                frame_offset += this_bytes // self.frame_bytes
            self._queue_put(('done', done_bytes, frame_offset))
        except BaseException as exc:
            self._queue_put(('error', exc))

    def _acquire_prefetch_buffer(self):
        while self.prefetch_stop is not None and not self.prefetch_stop.is_set():
            try:
                return self.prefetch_buffer_pool.get(timeout=0.1)
            except queue.Empty:
                continue
        return None

    def _return_prefetch_buffer(self, buf):
        if self.prefetch_buffer_pool is None:
            return
        try:
            self.prefetch_buffer_pool.put_nowait(buf)
        except queue.Full:
            pass

    def _prefetch_worker_bytearray(self):
        stream_tail = bytearray()
        done_bytes = 0
        frame_offset = 0
        try:
            while self.prefetch_stop is not None and not self.prefetch_stop.is_set():
                buf = self._acquire_prefetch_buffer()
                if buf is None:
                    break
                filled = 0
                if stream_tail:
                    filled = len(stream_tail)
                    buf[:filled] = stream_tail
                    stream_tail.clear()
                view = memoryview(buf)
                target = view[filled:self.chunk_bytes]
                try:
                    got = self.handle.readinto(target)
                finally:
                    del target
                if not got:
                    del view
                    self._return_prefetch_buffer(buf)
                    if filled:
                        raise RuntimeError(self.partial_frame_error)
                    break
                filled += got
                this_bytes = filled - (filled % self.frame_bytes)
                if this_bytes <= 0:
                    stream_tail.extend(bytes(view[:filled]))
                    del view
                    self._return_prefetch_buffer(buf)
                    continue
                if this_bytes > len(self.host_buffer):
                    del view
                    self._return_prefetch_buffer(buf)
                    raise RuntimeError(f'{self.staging_label} exceeded: need={this_bytes} capacity={len(self.host_buffer)}')
                if done_bytes + this_bytes > self.nbytes:
                    del view
                    self._return_prefetch_buffer(buf)
                    if self.limit_kind == 'expected':
                        raise RuntimeError(f'{self.limit_label} exceeded first pass length: bytes={done_bytes + this_bytes} expected={self.nbytes}')
                    raise RuntimeError(f'streaming input exceeded allocation estimate: bytes={done_bytes + this_bytes} capacity={self.nbytes}')
                if filled > this_bytes:
                    stream_tail.extend(bytes(view[this_bytes:filled]))
                del view
                payload_ptr = ctypes.addressof(ctypes.c_char.from_buffer(buf))
                self._queue_put(('buffer_chunk', buf, payload_ptr, this_bytes, done_bytes, frame_offset))
                done_bytes += this_bytes
                frame_offset += this_bytes // self.frame_bytes
            self._queue_put(('done', done_bytes, frame_offset))
        except BaseException as exc:
            self._queue_put(('error', exc))

    def _iter_prefetch(self):
        host_view = memoryview(self.host_buffer)
        while True:
            kind, *payload = self.prefetch_queue.get()
            if kind == 'done':
                self.done_bytes, self.frame_offset = payload
                break
            if kind == 'error':
                raise payload[0]
            if kind == 'buffer_chunk':
                data, payload_ptr, this_bytes, done_bytes, frame_offset = payload
                if this_bytes % self.frame_bytes:
                    self._return_prefetch_buffer(data)
                    raise RuntimeError(self.alignment_error)
                this_frames = this_bytes // self.frame_bytes
                self.done_bytes = done_bytes + this_bytes
                self.frame_offset = frame_offset + this_frames
                try:
                    yield FrameChunk(
                        this_bytes=this_bytes,
                        this_frames=this_frames,
                        done_bytes=done_bytes,
                        frame_offset=frame_offset,
                        payload=data,
                        payload_ptr=payload_ptr,
                    )
                finally:
                    self._return_prefetch_buffer(data)
                continue
            data, done_bytes, frame_offset = payload
            this_bytes = len(data)
            if this_bytes % self.frame_bytes:
                raise RuntimeError(self.alignment_error)
            this_frames = this_bytes // self.frame_bytes
            payload_data = None
            payload_ptr = 0
            if self.direct_payload:
                if not isinstance(data, bytes):
                    data = bytes(data)
                payload_data = data
                payload_ptr = _bytes_data_ptr(data)
            else:
                host_view[:this_bytes] = data
            self.done_bytes = done_bytes + this_bytes
            self.frame_offset = frame_offset + this_frames
            yield FrameChunk(
                this_bytes=this_bytes,
                this_frames=this_frames,
                done_bytes=done_bytes,
                frame_offset=frame_offset,
                payload=payload_data,
                payload_ptr=payload_ptr,
            )
