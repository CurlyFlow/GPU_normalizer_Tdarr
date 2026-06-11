from __future__ import annotations

import ctypes
import ctypes.util
import math

from stream_chunk_reader import FrameChunk, FrameChunkReader
from stream_processes import close_decode_pass, start_decode_pass


AV_SAMPLE_FMT_DBL = 4
AV_ROUND_UP = 3


def _load_library(name, fallback):
    path = ctypes.util.find_library(name)
    return ctypes.CDLL(path or fallback)


class SwrIngressResampler:
    def __init__(self, channels, ingress_rate, output_rate):
        self.channels = int(channels)
        self.ingress_rate = int(ingress_rate)
        self.output_rate = int(output_rate)
        self.swr = _load_library('swresample', 'libswresample.so')
        self.avutil = _load_library('avutil', 'libavutil.so')
        self.ctx = None
        self._setup_api()

    def _setup_api(self):
        self.swr.swr_alloc_set_opts.restype = ctypes.c_void_p
        self.swr.swr_alloc_set_opts.argtypes = (
            ctypes.c_void_p,
            ctypes.c_int64,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int64,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_void_p,
        )
        self.swr.swr_init.restype = ctypes.c_int
        self.swr.swr_init.argtypes = (ctypes.c_void_p,)
        self.swr.swr_convert.restype = ctypes.c_int
        self.swr.swr_convert.argtypes = (ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.c_int, ctypes.POINTER(ctypes.c_void_p), ctypes.c_int)
        self.swr.swr_get_delay.restype = ctypes.c_int64
        self.swr.swr_get_delay.argtypes = (ctypes.c_void_p, ctypes.c_int64)
        self.swr.swr_free.argtypes = (ctypes.POINTER(ctypes.c_void_p),)
        try:
            self.avutil.av_get_default_channel_layout.restype = ctypes.c_int64
            self.avutil.av_get_default_channel_layout.argtypes = (ctypes.c_int,)
        except AttributeError as exc:
            raise RuntimeError('libavutil missing av_get_default_channel_layout') from exc

    def __enter__(self):
        layout = int(self.avutil.av_get_default_channel_layout(self.channels))
        if layout == 0:
            raise RuntimeError(f'failed to resolve channel layout for {self.channels} channels')
        self.ctx = ctypes.c_void_p(self.swr.swr_alloc_set_opts(
            None,
            ctypes.c_int64(layout),
            AV_SAMPLE_FMT_DBL,
            self.output_rate,
            ctypes.c_int64(layout),
            AV_SAMPLE_FMT_DBL,
            self.ingress_rate,
            0,
            None,
        ))
        if not self.ctx.value:
            raise RuntimeError('swr_alloc_set_opts failed')
        code = self.swr.swr_init(self.ctx)
        if code < 0:
            raise RuntimeError(f'swr_init failed: {code}')
        return self

    def __exit__(self, exc_type, exc, tb):
        if self.ctx is not None:
            ctx = ctypes.c_void_p(self.ctx.value)
            self.swr.swr_free(ctypes.byref(ctx))
            self.ctx = None

    def max_output_frames(self, input_frames):
        delay = self.swr.swr_get_delay(self.ctx, self.ingress_rate)
        return int(math.ceil((delay + int(input_frames)) * self.output_rate / float(self.ingress_rate)))

    def convert(self, input_ptr, input_frames, output_ptr, output_capacity_frames):
        out = (ctypes.c_void_p * 1)(ctypes.c_void_p(output_ptr))
        inp = (ctypes.c_void_p * 1)(ctypes.c_void_p(input_ptr)) if input_ptr else None
        in_arg = inp if inp is not None else None
        converted = self.swr.swr_convert(self.ctx, out, int(output_capacity_frames), in_arg, int(input_frames))
        if converted < 0:
            raise RuntimeError(f'swr_convert failed: {converted}')
        return int(converted)


class IngressResamplingFrameChunkReader:
    def __init__(self, args, cfg, decode_command, label, host_buffer, *, partial_frame_error, staging_label, short_read_error):
        self.args = args
        self.cfg = cfg
        self.decode_command = decode_command
        self.label = label
        self.host_buffer = host_buffer
        self.partial_frame_error = partial_frame_error
        self.staging_label = staging_label
        self.short_read_error = short_read_error
        self.reader = None
        self.resampler = None
        self.done_bytes = 0
        self.frame_offset = 0

    def __enter__(self):
        output_capacity_frames = max(1, len(self.host_buffer) // self.cfg.frame_bytes)
        input_frame_bytes = self.args.channels * self.cfg.input_sample_bytes
        input_frames = max(1, (output_capacity_frames * self.cfg.ingress_rate) // max(1, self.args.rate * 2))
        input_chunk_bytes = max(input_frame_bytes, input_frames * input_frame_bytes)
        input_chunk_bytes -= input_chunk_bytes % input_frame_bytes
        estimated_input_bytes = int(math.ceil(self.cfg.nbytes * (self.cfg.ingress_rate / float(self.args.rate))))
        estimated_input_bytes += (-estimated_input_bytes) % input_frame_bytes
        input_buffer = bytearray(input_chunk_bytes)
        self.reader = FrameChunkReader(
            self.args,
            self.cfg.streaming_io,
            self.decode_command,
            f'{self.label} ingress decode',
            input_buffer,
            nbytes=estimated_input_bytes,
            chunk_bytes=input_chunk_bytes,
            frame_bytes=input_frame_bytes,
            partial_frame_error=self.partial_frame_error,
            staging_label=f'{self.staging_label} ingress',
            short_read_error=self.short_read_error,
            direct_payload=True,
        ).__enter__()
        self.resampler = SwrIngressResampler(self.args.channels, self.cfg.ingress_rate, self.args.rate).__enter__()
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if self.resampler is not None:
                self.resampler.__exit__(exc_type, exc, tb)
        finally:
            if self.reader is not None:
                self.reader.__exit__(exc_type, exc, tb)

    def __iter__(self):
        host_ptr = ctypes.addressof(ctypes.c_char.from_buffer(self.host_buffer))
        output_capacity_frames = max(1, len(self.host_buffer) // self.cfg.frame_bytes)
        for input_chunk in self.reader:
            input_ptr = getattr(input_chunk, 'payload_ptr', 0) or ctypes.addressof(ctypes.c_char.from_buffer(self.reader.host_buffer))
            max_frames = self.resampler.max_output_frames(input_chunk.this_frames)
            if max_frames > output_capacity_frames:
                raise RuntimeError(f'{self.staging_label} resample output exceeded buffer: need_frames={max_frames} capacity_frames={output_capacity_frames}')
            converted = self.resampler.convert(input_ptr, input_chunk.this_frames, host_ptr, output_capacity_frames)
            if converted <= 0:
                continue
            yield self._chunk(converted)
        while True:
            converted = self.resampler.convert(0, 0, host_ptr, output_capacity_frames)
            if converted <= 0:
                break
            yield self._chunk(converted)

    def _chunk(self, frames):
        this_bytes = int(frames) * self.cfg.frame_bytes
        if self.done_bytes + this_bytes > self.cfg.nbytes:
            raise RuntimeError(f'{self.staging_label} resampled input exceeded allocation estimate: bytes={self.done_bytes + this_bytes} capacity={self.cfg.nbytes}')
        chunk = FrameChunk(
            this_bytes=this_bytes,
            this_frames=int(frames),
            done_bytes=self.done_bytes,
            frame_offset=self.frame_offset,
        )
        self.done_bytes += this_bytes
        self.frame_offset += int(frames)
        return chunk


class IngressResamplingReadHandle:
    def __init__(self, args, cfg, decode_command, label):
        self.args = args
        self.cfg = cfg
        self.decode_command = decode_command
        self.label = label
        self.proc = None
        self.handle = None
        self.resampler = None
        self.output_tail = bytearray()
        self.input_tail = bytearray()
        self.eof = False
        self.closed = False
        self.input_frame_bytes = args.channels * cfg.input_sample_bytes

    def open(self):
        self.proc, self.handle = start_decode_pass(self.args, self.cfg.streaming_io, self.decode_command, self.label)
        self.resampler = SwrIngressResampler(self.args.channels, self.cfg.ingress_rate, self.args.rate).__enter__()
        return self

    def read(self, size=-1):
        if self.closed:
            return b''
        target = max(1, int(size if size and size > 0 else self.cfg.chunk_bytes))
        while len(self.output_tail) < target and not self.eof:
            self._read_convert_chunk(target - len(self.output_tail))
        if len(self.output_tail) < target and self.eof:
            self._flush_until(target)
        if not self.output_tail:
            return b''
        take = len(self.output_tail) if size is None or size < 0 else min(int(size), len(self.output_tail))
        out = bytes(memoryview(self.output_tail)[:take])
        del self.output_tail[:take]
        return out

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            if self.resampler is not None:
                self.resampler.__exit__(None, None, None)
        finally:
            if self.handle is not None:
                close_decode_pass(self.proc, self.handle, self.label)

    def _read_convert_chunk(self, wanted_output_bytes):
        target_input_frames = max(1, int(math.ceil((wanted_output_bytes / max(1, self.cfg.frame_bytes)) * (self.cfg.ingress_rate / float(self.args.rate)))) + 64)
        target_input_bytes = max(self.input_frame_bytes, target_input_frames * self.input_frame_bytes)
        data = self.handle.read(target_input_bytes)
        if not data:
            self.eof = True
            if self.input_tail:
                raise RuntimeError('streaming ingress resample input ended with a partial frame')
            return
        self.input_tail.extend(data)
        aligned = len(self.input_tail) - (len(self.input_tail) % self.input_frame_bytes)
        if aligned <= 0:
            return
        payload = bytearray(memoryview(self.input_tail)[:aligned])
        del self.input_tail[:aligned]
        input_frames = aligned // self.input_frame_bytes
        input_ptr = ctypes.addressof(ctypes.c_char.from_buffer(payload))
        output_capacity_frames = max(1, self.resampler.max_output_frames(input_frames) + 64)
        output = bytearray(output_capacity_frames * self.cfg.frame_bytes)
        output_ptr = ctypes.addressof(ctypes.c_char.from_buffer(output))
        converted = self.resampler.convert(input_ptr, input_frames, output_ptr, output_capacity_frames)
        if converted > 0:
            self.output_tail.extend(memoryview(output)[:converted * self.cfg.frame_bytes])

    def _flush_until(self, target_bytes):
        while len(self.output_tail) < target_bytes:
            output_capacity_frames = max(1024, int(math.ceil((target_bytes - len(self.output_tail)) / max(1, self.cfg.frame_bytes))) + 1024)
            output = bytearray(output_capacity_frames * self.cfg.frame_bytes)
            output_ptr = ctypes.addressof(ctypes.c_char.from_buffer(output))
            converted = self.resampler.convert(0, 0, output_ptr, output_capacity_frames)
            if converted <= 0:
                break
            self.output_tail.extend(memoryview(output)[:converted * self.cfg.frame_bytes])


def frame_chunk_reader_for(ctx, decode_command, label, host_buffer, *, partial_frame_error, staging_label, short_read_error, chunk_bytes=None, direct_payload=False, direct_bytearray_payload=False, direct_payload_buffers=None, auto_return_payload=True):
    if getattr(ctx.cfg, 'ingress_rate', ctx.args.rate) != ctx.args.rate:
        return IngressResamplingFrameChunkReader(
            ctx.args,
            ctx.cfg,
            decode_command,
            label,
            host_buffer,
            partial_frame_error=partial_frame_error,
            staging_label=staging_label,
            short_read_error=short_read_error,
        )
    return FrameChunkReader(
        ctx.args,
        ctx.cfg.streaming_io,
        decode_command,
        label,
        host_buffer,
        nbytes=ctx.cfg.nbytes,
        chunk_bytes=chunk_bytes if chunk_bytes is not None else ctx.cfg.chunk_bytes,
        frame_bytes=ctx.cfg.frame_bytes,
        partial_frame_error=partial_frame_error,
        staging_label=staging_label,
        short_read_error=short_read_error,
        direct_payload=direct_payload,
        direct_bytearray_payload=direct_bytearray_payload,
        direct_payload_buffers=direct_payload_buffers,
        auto_return_payload=auto_return_payload,
    )
