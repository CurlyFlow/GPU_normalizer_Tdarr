from __future__ import annotations

import ctypes
from dataclasses import dataclass
import queue
import threading

from stream_env import env_bytes_mib, env_flag, env_int
from stream_processes import close_decode_pass, start_decode_pass


_PY_BYTES_AS_STRING = ctypes.pythonapi.PyBytes_AsString
_PY_BYTES_AS_STRING.argtypes = (ctypes.py_object,)
_PY_BYTES_AS_STRING.restype = ctypes.c_void_p


def _bytes_data_ptr(data):
    ptr = _PY_BYTES_AS_STRING(data)
    if not ptr:
        raise RuntimeError('failed to get bytes payload pointer')
    return int(ptr)


@dataclass
class FrameChunk:
    this_bytes: int
    this_frames: int
    done_bytes: int
    frame_offset: int
    payload: object = None
    payload_ptr: int = 0
    payload_releaser: object = None


class FrameChunkReader:
    def __init__(self, args, streaming_io, decode_command, label, host_buffer, *, nbytes, chunk_bytes, frame_bytes, partial_frame_error, staging_label, short_read_error, alignment_error='chunk is not frame-aligned', limit_kind='capacity', limit_label=None, direct_payload=False, direct_bytearray_payload=False, direct_payload_buffers=None, auto_return_payload=True):
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
        self.direct_payload_buffers = list(direct_payload_buffers) if direct_payload_buffers is not None else None
        self.auto_return_payload = bool(auto_return_payload)
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
                if self.direct_payload_buffers is not None:
                    queue_items = len(self.direct_payload_buffers)
                    if queue_items <= 0:
                        raise RuntimeError(f'{self.staging_label} direct payload buffer pool is empty')
                self.prefetch_buffer_pool = queue.Queue(maxsize=queue_items)
                if self.direct_payload_buffers is not None:
                    for item in self.direct_payload_buffers:
                        if isinstance(item, tuple):
                            self.prefetch_buffer_pool.put(item)
                        else:
                            self.prefetch_buffer_pool.put((item, ctypes.addressof(ctypes.c_char.from_buffer(item))))
                else:
                    for _ in range(queue_items):
                        buf = bytearray(self.chunk_bytes)
                        self.prefetch_buffer_pool.put((buf, ctypes.addressof(ctypes.c_char.from_buffer(buf))))
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
                item = self._acquire_prefetch_buffer()
                if item is None:
                    break
                buf, payload_ptr = item
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
                    self._return_prefetch_buffer(item)
                    if filled:
                        raise RuntimeError(self.partial_frame_error)
                    break
                filled += got
                this_bytes = filled - (filled % self.frame_bytes)
                if this_bytes <= 0:
                    stream_tail.extend(bytes(view[:filled]))
                    del view
                    self._return_prefetch_buffer(item)
                    continue
                if this_bytes > len(self.host_buffer):
                    del view
                    self._return_prefetch_buffer(item)
                    raise RuntimeError(f'{self.staging_label} exceeded: need={this_bytes} capacity={len(self.host_buffer)}')
                if done_bytes + this_bytes > self.nbytes:
                    del view
                    self._return_prefetch_buffer(item)
                    if self.limit_kind == 'expected':
                        raise RuntimeError(f'{self.limit_label} exceeded first pass length: bytes={done_bytes + this_bytes} expected={self.nbytes}')
                    raise RuntimeError(f'streaming input exceeded allocation estimate: bytes={done_bytes + this_bytes} capacity={self.nbytes}')
                if filled > this_bytes:
                    stream_tail.extend(bytes(view[this_bytes:filled]))
                del view
                self._queue_put(('buffer_chunk', item, buf, payload_ptr, this_bytes, done_bytes, frame_offset))
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
                item, data, payload_ptr, this_bytes, done_bytes, frame_offset = payload
                if this_bytes % self.frame_bytes:
                    self._return_prefetch_buffer(item)
                    raise RuntimeError(self.alignment_error)
                this_frames = this_bytes // self.frame_bytes
                self.done_bytes = done_bytes + this_bytes
                self.frame_offset = frame_offset + this_frames
                releaser = lambda item=item: self._return_prefetch_buffer(item)
                try:
                    yield FrameChunk(
                        this_bytes=this_bytes,
                        this_frames=this_frames,
                        done_bytes=done_bytes,
                        frame_offset=frame_offset,
                        payload=data,
                        payload_ptr=payload_ptr,
                        payload_releaser=releaser,
                    )
                finally:
                    if self.auto_return_payload:
                        self._return_prefetch_buffer(item)
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
