from __future__ import annotations


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

    def stage(self, input_base_frame, input_frames):
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
                self.buffer.extend(self.tail[:aligned])
                del self.tail[:aligned]
        available_frames = len(self.buffer) // self.frame_bytes
        if available_frames < input_frames:
            raise RuntimeError(f'short streaming input read during exact limiter apply: need_frames={input_frames} got_frames={available_frames}')
        input_bytes = input_frames * self.frame_bytes
        if input_bytes > len(self.host_in):
            raise RuntimeError(f'exact limiter input staging exceeded: need={input_bytes} capacity={len(self.host_in)}')
        memoryview(self.host_in)[:input_bytes] = self.buffer[:input_bytes]
        return input_bytes
