from __future__ import annotations

import os
import threading


def env_flag(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value in ('1', 'true', 'TRUE', 'yes', 'YES')


class ExactLimiterStreamWindow:
    def __init__(self, fh, host_in, *, frame_bytes, chunk_bytes, apply_input_chunk_bytes):
        self.fh = fh
        self.host_in = host_in
        self.frame_bytes = frame_bytes
        self.chunk_bytes = chunk_bytes
        self.apply_input_chunk_bytes = apply_input_chunk_bytes
        self.buffer = bytearray()
        self.base_frame = 0
        self.eof = False
        self.tail = bytearray()
        self.error = None
        self.prefetch_enabled = env_flag('LOUDNORM_GPU_PREFETCH_APPLY_DECODE', True)
        self.prefetch_stop = False
        self.prefetch_cv = threading.Condition()
        self.prefetch_thread = None
        self.max_buffer_bytes = max(apply_input_chunk_bytes + (chunk_bytes * 2), apply_input_chunk_bytes)
        if self.prefetch_enabled:
            self.prefetch_thread = threading.Thread(target=self._prefetch_worker, name='exact limiter decode prefetch', daemon=True)
            self.prefetch_thread.start()

    def stage(self, input_base_frame, input_frames):
        if self.prefetch_enabled:
            return self._stage_prefetched(input_base_frame, input_frames)
        if input_base_frame < self.base_frame:
            raise RuntimeError(f'streaming exact limiter window moved backwards: base={input_base_frame} buffered_base={self.base_frame}')
        if input_base_frame > self.base_frame:
            drop_bytes = (input_base_frame - self.base_frame) * self.frame_bytes
            if drop_bytes > len(self.buffer):
                raise RuntimeError('streaming exact limiter dropped beyond buffered input')
            del self.buffer[:drop_bytes]
            self.base_frame = input_base_frame
        required_frames = input_base_frame + input_frames
        while self.base_frame + (len(self.buffer) // self.frame_bytes) < required_frames:
            if self.eof:
                break
            data = self.fh.read(max(self.frame_bytes, min(self.chunk_bytes, self.apply_input_chunk_bytes) - len(self.tail)))
            if not data:
                self.eof = True
                if self.tail:
                    raise RuntimeError('streaming exact limiter input ended with a partial frame')
                break
            self.tail.extend(data)
            aligned = len(self.tail) - (len(self.tail) % self.frame_bytes)
            if aligned > 0:
                self.buffer.extend(memoryview(self.tail)[:aligned])
                del self.tail[:aligned]
        available_frames = len(self.buffer) // self.frame_bytes
        if available_frames < input_frames:
            raise RuntimeError(f'short streaming input read during exact limiter apply: need_frames={input_frames} got_frames={available_frames}')
        input_bytes = input_frames * self.frame_bytes
        if input_bytes > len(self.host_in):
            raise RuntimeError(f'exact limiter input staging exceeded: need={input_bytes} capacity={len(self.host_in)}')
        memoryview(self.host_in)[:input_bytes] = memoryview(self.buffer)[:input_bytes]
        return input_bytes

    def close(self):
        if not self.prefetch_enabled:
            return
        with self.prefetch_cv:
            self.prefetch_stop = True
            self.prefetch_cv.notify_all()
        if self.prefetch_thread is not None:
            self.prefetch_thread.join(timeout=5.0)

    def _prefetch_worker(self):
        try:
            while True:
                with self.prefetch_cv:
                    while not self.prefetch_stop and not self.eof and (len(self.buffer) + len(self.tail)) >= self.max_buffer_bytes:
                        self.prefetch_cv.wait(timeout=0.1)
                    if self.prefetch_stop or self.eof:
                        return
                data = self.fh.read(max(self.frame_bytes, min(self.chunk_bytes, self.apply_input_chunk_bytes)))
                with self.prefetch_cv:
                    if not data:
                        self.eof = True
                        if self.tail:
                            self.error = RuntimeError('streaming exact limiter input ended with a partial frame')
                        self.prefetch_cv.notify_all()
                        return
                    self.tail.extend(data)
                    aligned = len(self.tail) - (len(self.tail) % self.frame_bytes)
                    if aligned > 0:
                        self.buffer.extend(memoryview(self.tail)[:aligned])
                        del self.tail[:aligned]
                    self.prefetch_cv.notify_all()
        except BaseException as exc:
            with self.prefetch_cv:
                self.error = exc
                self.eof = True
                self.prefetch_cv.notify_all()

    def _stage_prefetched(self, input_base_frame, input_frames):
        input_bytes = input_frames * self.frame_bytes
        if input_bytes > len(self.host_in):
            raise RuntimeError(f'exact limiter input staging exceeded: need={input_bytes} capacity={len(self.host_in)}')
        with self.prefetch_cv:
            if input_base_frame < self.base_frame:
                raise RuntimeError(f'streaming exact limiter window moved backwards: base={input_base_frame} buffered_base={self.base_frame}')
            if input_base_frame > self.base_frame:
                drop_bytes = (input_base_frame - self.base_frame) * self.frame_bytes
                if drop_bytes > len(self.buffer):
                    raise RuntimeError('streaming exact limiter dropped beyond buffered input')
                del self.buffer[:drop_bytes]
                self.base_frame = input_base_frame
                self.prefetch_cv.notify_all()
            while len(self.buffer) // self.frame_bytes < input_frames:
                if self.error is not None:
                    raise self.error
                if self.eof:
                    break
                self.prefetch_cv.wait(timeout=0.1)
            if self.error is not None:
                raise self.error
            available_frames = len(self.buffer) // self.frame_bytes
            if available_frames < input_frames:
                raise RuntimeError(f'short streaming input read during exact limiter apply: need_frames={input_frames} got_frames={available_frames}')
            memoryview(self.host_in)[:input_bytes] = memoryview(self.buffer)[:input_bytes]
            return input_bytes
