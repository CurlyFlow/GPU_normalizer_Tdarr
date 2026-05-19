from __future__ import annotations

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


def start_decode_pass(args, streaming_io, decode_command, label):
    if not streaming_io:
        return None, open(args.input_f32, 'rb')
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
    proc = subprocess.Popen(encode_command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=sys.stderr)
    if proc.stdin is None:
        raise RuntimeError('encode failed to open stdin')
    return proc, proc.stdin


class AsyncEncodeWriter:
    def __init__(self, handle, *, max_items):
        self.handle = handle
        self.queue = queue.Queue(maxsize=max(1, max_items))
        self.closed = False
        self.aborted = False
        self.error = None
        self.worker_write_time = 0.0
        self.close_wait_time = 0.0
        self.peak_queue = 0
        self.thread = threading.Thread(target=self._worker, name='async encode writer', daemon=True)
        self.thread.start()

    def _worker(self):
        try:
            while True:
                item = self.queue.get()
                if item is None:
                    return
                if self.aborted:
                    continue
                t0 = time.perf_counter()
                self.handle.write(item)
                self.worker_write_time += time.perf_counter() - t0
        except BaseException as exc:
            self.error = exc

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
    if not streaming_io or not env_flag('LOUDNORM_GPU_ASYNC_ENCODE_WRITE', False):
        return handle, None
    max_items = env_int('LOUDNORM_GPU_ASYNC_ENCODE_WRITE_QUEUE', 32)
    max_bytes = env_bytes_mib('LOUDNORM_GPU_ASYNC_ENCODE_WRITE_MAX_MIB', 512)
    byte_limited_items = max(1, max_bytes // max(1, chunk_bytes))
    writer = AsyncEncodeWriter(handle, max_items=min(max_items, byte_limited_items))
    return writer, writer


def finish_encode_pass(proc, handle):
    if proc is None:
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


class FrameChunkReader:
    def __init__(self, args, streaming_io, decode_command, label, host_buffer, *, nbytes, chunk_bytes, frame_bytes, partial_frame_error, staging_label, short_read_error, alignment_error='chunk is not frame-aligned', limit_kind='capacity', limit_label=None):
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
        self.proc = None
        self.handle = None
        self.done_bytes = 0
        self.frame_offset = 0
        self.prefetch_enabled = False
        self.prefetch_queue = None
        self.prefetch_stop = None
        self.prefetch_thread = None

    def __enter__(self):
        self.proc, self.handle = start_decode_pass(self.args, self.streaming_io, self.decode_command, self.label)
        self.prefetch_enabled = bool(self.streaming_io and env_flag('LOUDNORM_GPU_PREFETCH_DECODE', True))
        if self.prefetch_enabled:
            max_items = env_int('LOUDNORM_GPU_PREFETCH_DECODE_QUEUE', 32)
            max_bytes = env_bytes_mib('LOUDNORM_GPU_PREFETCH_DECODE_MAX_MIB', 512)
            byte_limited_items = max(1, max_bytes // max(1, self.chunk_bytes))
            self.prefetch_queue = queue.Queue(maxsize=max(1, min(max_items, byte_limited_items)))
            self.prefetch_stop = threading.Event()
            self.prefetch_thread = threading.Thread(target=self._prefetch_worker, name=f'{self.label} prefetch', daemon=True)
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
                payload = bytes(stream_tail[:this_bytes])
                del stream_tail[:this_bytes]
                self._queue_put(('chunk', payload, done_bytes, frame_offset))
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
            data, done_bytes, frame_offset = payload
            this_bytes = len(data)
            if this_bytes % self.frame_bytes:
                raise RuntimeError(self.alignment_error)
            this_frames = this_bytes // self.frame_bytes
            host_view[:this_bytes] = data
            self.done_bytes = done_bytes + this_bytes
            self.frame_offset = frame_offset + this_frames
            yield FrameChunk(
                this_bytes=this_bytes,
                this_frames=this_frames,
                done_bytes=done_bytes,
                frame_offset=frame_offset,
            )
