from __future__ import annotations

from dataclasses import dataclass
import subprocess
import sys


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

    def __enter__(self):
        self.proc, self.handle = start_decode_pass(self.args, self.streaming_io, self.decode_command, self.label)
        return self

    def __exit__(self, exc_type, exc, tb):
        close_decode_pass(self.proc, self.handle, self.label)

    def __iter__(self):
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
