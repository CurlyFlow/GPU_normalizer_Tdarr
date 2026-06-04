from __future__ import annotations

import threading
import ctypes

from cuda_driver import chk
from runtime_env import env_flag


class ExactLimiterStreamWindow:
    def __init__(self, fh, host_in, *, frame_bytes, chunk_bytes, apply_input_chunk_bytes, prefetch_enabled=None, prefetch_extra_chunks=2, limit_frames=None):
        self.fh = fh
        self.host_in = host_in
        self.frame_bytes = frame_bytes
        self.chunk_bytes = chunk_bytes
        self.apply_input_chunk_bytes = apply_input_chunk_bytes
        self.buffer = bytearray()
        self.buffer_offset = 0
        self.base_frame = 0
        self.eof = False
        self.tail = bytearray()
        self.error = None
        self.limit_frames = int(limit_frames) if limit_frames is not None else None
        self.prefetch_enabled = env_flag('LOUDNORM_GPU_PREFETCH_APPLY_DECODE', False) if prefetch_enabled is None else bool(prefetch_enabled)
        self.prefetch_aligned_fastpath = self.prefetch_enabled and env_flag('LOUDNORM_GPU_PREFETCH_ALIGNED_FASTPATH', True)
        self.logical_trim = env_flag('LOUDNORM_GPU_EXACT_STREAM_RING', True)
        self.prefetch_stop = False
        self.prefetch_cv = threading.Condition()
        self.prefetch_thread = None
        self.max_buffer_bytes = max(apply_input_chunk_bytes + (chunk_bytes * max(0, int(prefetch_extra_chunks))), apply_input_chunk_bytes)
        if self.prefetch_enabled:
            self.prefetch_thread = threading.Thread(target=self._prefetch_worker, name='exact limiter decode prefetch', daemon=True)
            self.prefetch_thread.start()

    def _buffered_bytes(self):
        return len(self.buffer) - self.buffer_offset

    def _buffered_frames(self):
        return self._buffered_bytes() // self.frame_bytes

    def _limit_reached(self):
        return self.limit_frames is not None and self.base_frame + self._buffered_frames() >= self.limit_frames

    def _drop_to(self, input_base_frame):
        if input_base_frame < self.base_frame:
            raise RuntimeError(f'streaming exact limiter window moved backwards: base={input_base_frame} buffered_base={self.base_frame}')
        if input_base_frame <= self.base_frame:
            return
        drop_bytes = (input_base_frame - self.base_frame) * self.frame_bytes
        if drop_bytes > self._buffered_bytes():
            raise RuntimeError('streaming exact limiter dropped beyond buffered input')
        if self.logical_trim:
            self.buffer_offset += drop_bytes
            self._compact_if_needed()
        else:
            del self.buffer[:drop_bytes]
        self.base_frame = input_base_frame

    def _compact_if_needed(self):
        if self.buffer_offset <= 0:
            return
        threshold = max(self.apply_input_chunk_bytes, 32 * 1024 * 1024)
        if self.buffer_offset >= threshold or self.buffer_offset >= (len(self.buffer) // 2):
            del self.buffer[:self.buffer_offset]
            self.buffer_offset = 0

    def stage(self, input_base_frame, input_frames):
        if self.prefetch_enabled:
            return self._stage_prefetched(input_base_frame, input_frames)
        self._drop_to(input_base_frame)
        required_frames = input_base_frame + input_frames
        while self.base_frame + self._buffered_frames() < required_frames:
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
        available_frames = self._buffered_frames()
        if available_frames < input_frames:
            raise RuntimeError(f'short streaming input read during exact limiter apply: need_frames={input_frames} got_frames={available_frames}')
        input_bytes = input_frames * self.frame_bytes
        if input_bytes > len(self.host_in):
            raise RuntimeError(f'exact limiter input staging exceeded: need={input_bytes} capacity={len(self.host_in)}')
        buffer_start = self.buffer_offset
        memoryview(self.host_in)[:input_bytes] = memoryview(self.buffer)[buffer_start:buffer_start + input_bytes]
        return input_bytes

    def stage_device(self, cuda, dst, input_base_frame, input_frames):
        if self.prefetch_enabled:
            return self._stage_prefetched_device(cuda, dst, input_base_frame, input_frames)
        self._drop_to(input_base_frame)
        required_frames = input_base_frame + input_frames
        while self.base_frame + self._buffered_frames() < required_frames:
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
        available_frames = self._buffered_frames()
        if available_frames < input_frames:
            raise RuntimeError(f'short streaming input read during exact limiter apply: need_frames={input_frames} got_frames={available_frames}')
        input_bytes = input_frames * self.frame_bytes
        if input_bytes > len(self.host_in):
            raise RuntimeError(f'exact limiter input staging exceeded: need={input_bytes} capacity={len(self.host_in)}')
        if input_bytes > 0:
            input_ptr = ctypes.addressof(ctypes.c_char.from_buffer(self.buffer, self.buffer_offset))
            chk(cuda.cuMemcpyHtoD_v2(dst, ctypes.c_void_p(input_ptr), input_bytes), 'cuMemcpyHtoD(apply input direct)')
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
                    if self._limit_reached():
                        self.eof = True
                        self.prefetch_cv.notify_all()
                        return
                    while not self.prefetch_stop and not self.eof and (self._buffered_bytes() + len(self.tail)) >= self.max_buffer_bytes:
                        self.prefetch_cv.wait(timeout=0.1)
                    if self.prefetch_stop or self.eof:
                        return
                    if self._limit_reached():
                        self.eof = True
                        self.prefetch_cv.notify_all()
                        return
                data = self.fh.read(max(self.frame_bytes, min(self.chunk_bytes, self.apply_input_chunk_bytes)))
                with self.prefetch_cv:
                    if not data:
                        self.eof = True
                        if self.tail:
                            self.error = RuntimeError('streaming exact limiter input ended with a partial frame')
                        self.prefetch_cv.notify_all()
                        return
                    if self.prefetch_aligned_fastpath and not self.tail and (len(data) % self.frame_bytes) == 0:
                        self.buffer.extend(data)
                        self.prefetch_cv.notify_all()
                        continue
                    self.tail.extend(data)
                    aligned = len(self.tail) - (len(self.tail) % self.frame_bytes)
                    if aligned > 0:
                        self.buffer.extend(memoryview(self.tail)[:aligned])
                        del self.tail[:aligned]
                    if self._limit_reached():
                        self.eof = True
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
            old_base_frame = self.base_frame
            self._drop_to(input_base_frame)
            if self.base_frame != old_base_frame:
                self.prefetch_cv.notify_all()
            while self._buffered_frames() < input_frames:
                if self.error is not None:
                    raise self.error
                if self.eof:
                    break
                self.prefetch_cv.wait(timeout=0.1)
            if self.error is not None:
                raise self.error
            available_frames = self._buffered_frames()
            if available_frames < input_frames:
                raise RuntimeError(f'short streaming input read during exact limiter apply: need_frames={input_frames} got_frames={available_frames}')
            buffer_start = self.buffer_offset
            memoryview(self.host_in)[:input_bytes] = memoryview(self.buffer)[buffer_start:buffer_start + input_bytes]
            return input_bytes

    def _stage_prefetched_device(self, cuda, dst, input_base_frame, input_frames):
        input_bytes = input_frames * self.frame_bytes
        if input_bytes > len(self.host_in):
            raise RuntimeError(f'exact limiter input staging exceeded: need={input_bytes} capacity={len(self.host_in)}')
        with self.prefetch_cv:
            old_base_frame = self.base_frame
            self._drop_to(input_base_frame)
            if self.base_frame != old_base_frame:
                self.prefetch_cv.notify_all()
            while self._buffered_frames() < input_frames:
                if self.error is not None:
                    raise self.error
                if self.eof:
                    break
                self.prefetch_cv.wait(timeout=0.1)
            if self.error is not None:
                raise self.error
            available_frames = self._buffered_frames()
            if available_frames < input_frames:
                raise RuntimeError(f'short streaming input read during exact limiter apply: need_frames={input_frames} got_frames={available_frames}')
            if input_bytes > 0:
                input_ptr = ctypes.addressof(ctypes.c_char.from_buffer(self.buffer, self.buffer_offset))
                chk(cuda.cuMemcpyHtoD_v2(dst, ctypes.c_void_p(input_ptr), input_bytes), 'cuMemcpyHtoD(apply input direct)')
            return input_bytes
