"""GPU-owned exact FFmpeg libswresample 48 kHz f32le -> 192 kHz f64le streaming upsampler."""

from __future__ import annotations

import ctypes
import math
import struct
import time

from cuda_driver import chk
from kernel_args import build_swr_upsample_48k_to_192k_args
from stream_chunk_reader import FrameChunk, FrameChunkReader
from swr_output_downsample import _av_bessel_i0_small


SWR_48K_TO_192K_TAPS = 32
SWR_48K_TO_192K_PHASES = 4
SWR_48K_TO_192K_CENTER = 15
SWR_48K_TO_192K_RIGHT_RADIUS = 16
SWR_48K_TO_192K_HALO_FRAMES = 32


def _f32(value: float) -> float:
    return struct.unpack('<f', struct.pack('<f', float(value)))[0]


def build_swr_48k_to_192k_filters() -> tuple[float, ...]:
    """Reproduce FFmpeg 7.1.2 libswresample build_filter() for 48k->192k FLTP (4 phases x 32 float32 taps)."""
    b0 = _av_bessel_i0_small(9.0)
    flat: list[float] = []
    for phase in range(SWR_48K_TO_192K_PHASES):
        for idx in range(SWR_48K_TO_192K_TAPS):
            x = math.pi * ((idx - SWR_48K_TO_192K_CENTER) - (phase / float(SWR_48K_TO_192K_PHASES)))
            val = 1.0 if x == 0.0 else math.sin(x) / x
            w = 2.0 * x / (float(SWR_48K_TO_192K_TAPS) * math.pi)
            val *= _av_bessel_i0_small(9.0 * math.sqrt(max(1.0 - w * w, 0.0)))
            flat.append(_f32(val / b0))
    return tuple(flat)


def swr_48k_to_192k_output_frames(total_source_frames: int) -> int:
    if total_source_frames <= 0:
        return 0
    return int(total_source_frames) * 4


def swr_48k_to_192k_ready_output_end(received_in_frames: int, total_in_frames: int | None, *, is_final: bool) -> int:
    if is_final:
        total = int(received_in_frames if total_in_frames is None else total_in_frames)
        return swr_48k_to_192k_output_frames(total)
    if received_in_frames <= SWR_48K_TO_192K_RIGHT_RADIUS:
        return 0
    ready_in_frames = received_in_frames - SWR_48K_TO_192K_RIGHT_RADIUS
    return ready_in_frames * 4


class GpuSwrUpsampler48kTo192k:
    """Streaming GPU 48 kHz f32le -> 192 kHz f64le polyphase FIR upsampler."""

    def __init__(self, cuda, *, channels: int, max_in_chunk_frames: int, allocate_output: bool = True, align_output_frames: int = 1):
        if channels < 1 or channels > 64:
            raise RuntimeError(f'Invalid channel count for GPU SWR upsampler: {channels}')
        self.channels = int(channels)
        self.in_frame_bytes = self.channels * 4
        self.out_frame_bytes = self.channels * 8
        self.allocate_output = bool(allocate_output)
        self.align_output_frames = max(1, int(align_output_frames))
        self.halo_frames = 0
        self.halo_capacity_frames = SWR_48K_TO_192K_HALO_FRAMES + ((self.align_output_frames + 3) // 4)
        self.received_in_frames = 0
        self.emitted_out_frames = 0

        self.stage_capacity_frames = max(int(max_in_chunk_frames), 1) + self.halo_capacity_frames
        self.out_capacity_frames = (self.stage_capacity_frames * 4) if self.allocate_output else 0

        self.d_filter = ctypes.c_void_p()
        self.d_stage_f32 = ctypes.c_void_p()
        self.d_halo_tmp = ctypes.c_void_p()
        self.d_out_f64 = ctypes.c_void_p()

        try:
            filt = build_swr_48k_to_192k_filters()
            filt_arr = (ctypes.c_float * (SWR_48K_TO_192K_PHASES * SWR_48K_TO_192K_TAPS))(*filt)
            chk(cuda.cuMemAlloc_v2(ctypes.byref(self.d_filter), ctypes.sizeof(filt_arr)), 'cuMemAlloc(swr up filter)')
            chk(cuda.cuMemcpyHtoD_v2(self.d_filter, ctypes.cast(filt_arr, ctypes.c_void_p), ctypes.sizeof(filt_arr)), 'cuMemcpyHtoD(swr up filter)')
            chk(cuda.cuMemAlloc_v2(ctypes.byref(self.d_stage_f32), self.stage_capacity_frames * self.in_frame_bytes), 'cuMemAlloc(swr up stage)')
            chk(cuda.cuMemAlloc_v2(ctypes.byref(self.d_halo_tmp), self.halo_capacity_frames * self.in_frame_bytes), 'cuMemAlloc(swr up halo)')
            if self.allocate_output:
                chk(cuda.cuMemAlloc_v2(ctypes.byref(self.d_out_f64), self.out_capacity_frames * self.out_frame_bytes), 'cuMemAlloc(swr up out)')
        except BaseException:
            self.cleanup(cuda)
            raise

    def _ensure_halo_capacity(self, cuda, needed_halo_frames: int):
        if needed_halo_frames <= self.halo_capacity_frames:
            return
        new_cap = int(needed_halo_frames)
        new_halo = ctypes.c_void_p()
        chk(cuda.cuMemAlloc_v2(ctypes.byref(new_halo), new_cap * self.in_frame_bytes), 'cuMemAlloc(swr up halo grow)')
        if self.d_halo_tmp.value:
            cuda.cuMemFree_v2(self.d_halo_tmp)
        self.d_halo_tmp = new_halo
        self.halo_capacity_frames = new_cap

    def _ensure_stage_capacity(self, cuda, needed_stage_frames: int, *, preserve_halo: bool):
        if needed_stage_frames <= self.stage_capacity_frames:
            return
        new_stage_cap = int(needed_stage_frames)
        new_stage = ctypes.c_void_p()
        chk(cuda.cuMemAlloc_v2(ctypes.byref(new_stage), new_stage_cap * self.in_frame_bytes), 'cuMemAlloc(swr up stage grow)')
        if preserve_halo and self.halo_frames > 0:
            chk(cuda.cuMemcpyDtoD_v2(new_stage, self.d_stage_f32, self.halo_frames * self.in_frame_bytes), 'cuMemcpyDtoD(swr up stage grow)')
        cuda.cuMemFree_v2(self.d_stage_f32)
        self.d_stage_f32 = new_stage
        self.stage_capacity_frames = new_stage_cap

    def _ensure_output_capacity(self, cuda, needed_out_frames: int):
        if not self.allocate_output or needed_out_frames <= self.out_capacity_frames:
            return
        new_out_cap = int(needed_out_frames)
        new_out = ctypes.c_void_p()
        chk(cuda.cuMemAlloc_v2(ctypes.byref(new_out), new_out_cap * self.out_frame_bytes), 'cuMemAlloc(swr up out grow)')
        if self.d_out_f64.value:
            cuda.cuMemFree_v2(self.d_out_f64)
        self.d_out_f64 = new_out
        self.out_capacity_frames = new_out_cap

    def launch_window_to_device(
        self,
        ctx,
        result,
        *,
        host_f32_ptr: int,
        in_frames: int,
        window_start_in_frame: int,
        total_in_frames: int,
        output_dev_ptr: int,
        output_start_frame: int,
        output_count: int,
        track_apply: bool = True,
    ):
        cuda = ctx.cuda
        self._ensure_stage_capacity(cuda, in_frames, preserve_halo=False)
        t0 = time.perf_counter()
        chk(
            cuda.cuMemcpyHtoD_v2(self.d_stage_f32, ctypes.c_void_p(int(host_f32_ptr)), in_frames * self.in_frame_bytes),
            'cuMemcpyHtoD(swr up window)',
        )
        copy_dt = time.perf_counter() - t0
        result.total_h2d_time += copy_dt
        if track_apply:
            result.apply_h2d_time += copy_dt

        input_arg = ctypes.c_uint64(self.d_stage_f32.value)
        filter_arg = ctypes.c_uint64(self.d_filter.value)
        output_arg = ctypes.c_uint64(int(output_dev_ptr))
        window_start_arg = ctypes.c_uint64(window_start_in_frame)
        total_in_arg = ctypes.c_uint64(total_in_frames)
        output_start_arg = ctypes.c_uint64(output_start_frame)
        output_count_arg = ctypes.c_uint64(output_count)
        channels_arg = ctypes.c_uint32(self.channels)
        params = build_swr_upsample_48k_to_192k_args(
            input_arg,
            filter_arg,
            output_arg,
            window_start_arg,
            total_in_arg,
            output_start_arg,
            output_count_arg,
            channels_arg,
        )
        k_first = int(output_start_frame) >> 2
        k_last = (int(output_start_frame) + int(output_count) - 1) >> 2
        total_work = (k_last - k_first + 1) * self.channels
        grid = (total_work + 255) // 256
        k0 = time.perf_counter()
        chk(
            cuda.cuLaunchKernel(ctx.kernels.swr_upsample_fn, grid, 1, 1, 256, 1, 1, 0, None, params, None),
            'cuLaunchKernel(swr_upsample_48k_to_192k)',
        )
        chk(cuda.cuCtxSynchronize(), 'cuCtxSynchronize(swr_upsample_48k_to_192k)')
        kdt = time.perf_counter() - k0
        if track_apply:
            result.apply_kernel_time += kdt

    def process_host_chunk(self, ctx, result, *, host_f32_ptr: int, in_frames: int, is_final: bool):
        cuda = ctx.cuda
        in_frames = int(in_frames)
        if in_frames < 0:
            raise RuntimeError(f'Negative in_frames in GPU SWR upsampler: {in_frames}')
        window_frames = self.halo_frames + in_frames
        window_start_in_frame = self.received_in_frames - self.halo_frames
        new_received = self.received_in_frames + in_frames
        total_in_frames = new_received if is_final else (new_received + SWR_48K_TO_192K_HALO_FRAMES)
        ready_end = swr_48k_to_192k_ready_output_end(new_received, new_received if is_final else None, is_final=is_final)
        if not is_final and self.align_output_frames > 1:
            ready_end = (ready_end // self.align_output_frames) * self.align_output_frames
        output_count = max(0, ready_end - self.emitted_out_frames)
        self._ensure_stage_capacity(cuda, window_frames, preserve_halo=True)
        self._ensure_output_capacity(cuda, max(output_count, 1))

        if in_frames > 0:
            dst_ptr = ctypes.c_void_p(self.d_stage_f32.value + self.halo_frames * self.in_frame_bytes)
            t0 = time.perf_counter()
            chk(
                cuda.cuMemcpyHtoD_v2(dst_ptr, ctypes.c_void_p(int(host_f32_ptr)), in_frames * self.in_frame_bytes),
                'cuMemcpyHtoD(swr up input)',
            )
            dt = time.perf_counter() - t0
            if result is not None:
                result.total_h2d_time += dt
        self.received_in_frames = new_received

        if output_count > 0:
            input_arg = ctypes.c_uint64(self.d_stage_f32.value)
            filter_arg = ctypes.c_uint64(self.d_filter.value)
            output_arg = ctypes.c_uint64(self.d_out_f64.value)
            window_start_arg = ctypes.c_uint64(window_start_in_frame)
            total_in_arg = ctypes.c_uint64(total_in_frames)
            output_start_arg = ctypes.c_uint64(self.emitted_out_frames)
            output_count_arg = ctypes.c_uint64(output_count)
            channels_arg = ctypes.c_uint32(self.channels)
            params = build_swr_upsample_48k_to_192k_args(
                input_arg,
                filter_arg,
                output_arg,
                window_start_arg,
                total_in_arg,
                output_start_arg,
                output_count_arg,
                channels_arg,
            )
            k_first = int(self.emitted_out_frames) >> 2
            k_last = (int(self.emitted_out_frames) + int(output_count) - 1) >> 2
            total_work = (k_last - k_first + 1) * self.channels
            grid = (total_work + 255) // 256
            chk(
                cuda.cuLaunchKernel(ctx.kernels.swr_upsample_fn, grid, 1, 1, 256, 1, 1, 0, None, params, None),
                'cuLaunchKernel(swr_upsample_48k_to_192k)',
            )
            chk(cuda.cuCtxSynchronize(), 'cuCtxSynchronize(swr_upsample_48k_to_192k)')
            self.emitted_out_frames += output_count

        if not is_final:
            next_k = self.emitted_out_frames >> 2
            min_needed_in = max(0, next_k - SWR_48K_TO_192K_CENTER)
            keep = min(window_frames, max(SWR_48K_TO_192K_HALO_FRAMES, new_received - min_needed_in))
            if keep > 0:
                offset = (window_frames - keep) * self.in_frame_bytes
                if offset > 0:
                    self._ensure_halo_capacity(cuda, keep)
                    keep_bytes = keep * self.in_frame_bytes
                    src_tail = ctypes.c_void_p(self.d_stage_f32.value + offset)
                    chk(cuda.cuMemcpyDtoD_v2(self.d_halo_tmp, src_tail, keep_bytes), 'cuMemcpyDtoD(swr up halo save)')
                    chk(cuda.cuMemcpyDtoD_v2(self.d_stage_f32, self.d_halo_tmp, keep_bytes), 'cuMemcpyDtoD(swr up halo restore)')
            self.halo_frames = keep
        else:
            self.halo_frames = 0

        return self.d_out_f64.value, output_count

    def cleanup(self, cuda):
        for attr in ('d_filter', 'd_stage_f32', 'd_halo_tmp', 'd_out_f64'):
            ptr = getattr(self, attr, None)
            if ptr is not None and getattr(ptr, 'value', 0):
                cuda.cuMemFree_v2(ptr)
                setattr(self, attr, ctypes.c_void_p())


class GpuSwrUpsamplingWindow:
    """Drop-in ExactLimiterStreamWindow replacement that buffers 48 kHz f32le and upsamples directly to ctx.buffers.d_in."""

    def __init__(self, ctx, fh, *, channels: int, apply_input_chunk_bytes: int):
        self.ctx = ctx
        self.fh = fh
        self.channels = int(channels)
        self.in_frame_bytes = self.channels * 4
        self.out_frame_bytes = self.channels * 8
        self.buffer = bytearray()
        self.buffer_offset = 0
        self.base_in_frame = 0
        self.eof = False
        self.tail = bytearray()
        max_out_frames = max(1, int(apply_input_chunk_bytes) // self.out_frame_bytes)
        max_in_frames = (max_out_frames // 4) + SWR_48K_TO_192K_HALO_FRAMES + 4
        self.read_chunk_bytes = max(self.in_frame_bytes, min(max_in_frames * self.in_frame_bytes, 4 * 1024 * 1024))
        self.upsampler = GpuSwrUpsampler48kTo192k(
            ctx.cuda,
            channels=self.channels,
            max_in_chunk_frames=max_in_frames,
            allocate_output=False,
        )

    def _buffered_bytes(self) -> int:
        return len(self.buffer) - self.buffer_offset

    def _buffered_in_frames(self) -> int:
        return self._buffered_bytes() // self.in_frame_bytes

    def _drop_to_in_frame(self, target_in_frame: int):
        if target_in_frame < self.base_in_frame:
            raise RuntimeError(f'GPU SWR upsample window moved backwards: base={target_in_frame} buffered_base={self.base_in_frame}')
        if target_in_frame <= self.base_in_frame:
            return
        drop_bytes = (target_in_frame - self.base_in_frame) * self.in_frame_bytes
        if drop_bytes > self._buffered_bytes():
            raise RuntimeError('GPU SWR upsample window dropped beyond buffered input')
        self.buffer_offset += drop_bytes
        if self.buffer_offset >= (16 * 1024 * 1024) or self.buffer_offset >= (len(self.buffer) // 2):
            del self.buffer[:self.buffer_offset]
            self.buffer_offset = 0
        self.base_in_frame = target_in_frame

    def stage_to_device(self, ctx, result, input_base_frame: int, input_frames: int) -> int:
        if input_frames <= 0:
            return 0
        k_first = int(input_base_frame) >> 2
        k_last = (int(input_base_frame) + int(input_frames) - 1) >> 2
        in_start = max(0, k_first - SWR_48K_TO_192K_CENTER)
        in_end_need = k_last + SWR_48K_TO_192K_RIGHT_RADIUS + 1
        self._drop_to_in_frame(in_start)
        while self.base_in_frame + self._buffered_in_frames() < in_end_need and not self.eof:
            data = self.fh.read(max(self.in_frame_bytes, self.read_chunk_bytes - len(self.tail)))
            if not data:
                self.eof = True
                if self.tail:
                    raise RuntimeError('GPU SWR upsample input ended with a partial 48 kHz f32le frame')
                break
            self.tail.extend(data)
            aligned = len(self.tail) - (len(self.tail) % self.in_frame_bytes)
            if aligned > 0:
                self.buffer.extend(memoryview(self.tail)[:aligned])
                del self.tail[:aligned]
        buffered_end = self.base_in_frame + self._buffered_in_frames()
        if self.eof:
            total_in_frames = buffered_end
            if (int(input_base_frame) + int(input_frames)) > total_in_frames * 4:
                raise RuntimeError(
                    f'short streaming 48k input during GPU SWR upsample: need_out={input_base_frame + input_frames} got_out={total_in_frames * 4}'
                )
            in_end = min(in_end_need, total_in_frames)
        else:
            total_in_frames = in_end_need + SWR_48K_TO_192K_HALO_FRAMES
            in_end = in_end_need
        window_in_frames = in_end - self.base_in_frame
        if window_in_frames <= 0:
            raise RuntimeError('GPU SWR upsample window has no buffered 48 kHz frames')
        buf_base_ptr = ctypes.addressof(ctypes.c_char.from_buffer(self.buffer))
        self.upsampler.launch_window_to_device(
            ctx,
            result,
            host_f32_ptr=buf_base_ptr + self.buffer_offset,
            in_frames=window_in_frames,
            window_start_in_frame=self.base_in_frame,
            total_in_frames=total_in_frames,
            output_dev_ptr=ctx.buffers.d_in.value,
            output_start_frame=int(input_base_frame),
            output_count=int(input_frames),
            track_apply=True,
        )
        return 0

    def stage(self, input_base_frame: int, input_frames: int) -> int:
        """Fallback host staging used only by <3s short_source.py."""
        self.stage_to_device(self.ctx, self.ctx._short_swr_result if hasattr(self.ctx, '_short_swr_result') else _NullResult(), input_base_frame, input_frames)
        out_bytes = int(input_frames) * self.out_frame_bytes
        if out_bytes > len(self.ctx.host_io.host_in):
            raise RuntimeError(f'GPU SWR short host staging exceeded: need={out_bytes} capacity={len(self.ctx.host_io.host_in)}')
        chk(
            self.ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(self.ctx.host_io.host_in_ptr), self.ctx.buffers.d_in, out_bytes),
            'cuMemcpyDtoH(swr up short)',
        )
        return out_bytes

    def close(self):
        self.cleanup(self.ctx.cuda)

    def cleanup(self, cuda):
        if self.upsampler is not None:
            self.upsampler.cleanup(cuda)
            self.upsampler = None


class _NullResult:
    total_h2d_time = 0.0
    apply_h2d_time = 0.0
    apply_kernel_time = 0.0


class GpuSwrUpsamplingFrameChunkReader:
    """Drop-in FrameChunkReader that reads 48 kHz f32le, upsamples on GPU, and yields 192 kHz f64le FrameChunks."""

    def __init__(self, ctx, decode_command, label, host_buffer, *, partial_frame_error, staging_label, short_read_error, chunk_bytes=None):
        self.ctx = ctx
        self.args = ctx.args
        self.cfg = ctx.cfg
        self.decode_command = decode_command
        self.label = label
        self.host_buffer = host_buffer
        self.partial_frame_error = partial_frame_error
        self.staging_label = staging_label
        self.short_read_error = short_read_error
        self.out_frame_bytes = self.args.channels * 8
        self.in_frame_bytes = self.args.channels * 4
        max_out_bytes = len(self.host_buffer)
        if chunk_bytes is not None:
            max_out_bytes = min(max_out_bytes, int(chunk_bytes))
        self.frames_per_window = max(1, int(getattr(self.cfg.input_shape, 'frames_per_window', 1)))
        raw_max_out_frames = max(4, max_out_bytes // self.out_frame_bytes)
        if raw_max_out_frames >= self.frames_per_window:
            self.max_out_frames = (raw_max_out_frames // self.frames_per_window) * self.frames_per_window
        else:
            self.max_out_frames = raw_max_out_frames
        self.in_chunk_frames = max(SWR_48K_TO_192K_HALO_FRAMES, self.max_out_frames // 4)
        self.reader = None
        self.upsampler = None
        self.done_bytes = 0
        self.frame_offset = 0

    def __enter__(self):
        in_chunk_bytes = self.in_chunk_frames * self.in_frame_bytes
        est_in_bytes = max(in_chunk_bytes, ((self.cfg.input_shape.nbytes // self.out_frame_bytes) // 4 + 64) * self.in_frame_bytes)
        input_buffer = bytearray(in_chunk_bytes)
        self.reader = FrameChunkReader(
            self.args,
            self.cfg.root.streaming_io,
            self.decode_command,
            f'{self.label} swr48k decode',
            input_buffer,
            nbytes=est_in_bytes,
            chunk_bytes=in_chunk_bytes,
            frame_bytes=self.in_frame_bytes,
            partial_frame_error=self.partial_frame_error,
            staging_label=f'{self.staging_label} swr48k',
            short_read_error=self.short_read_error,
            direct_payload=True,
        ).__enter__()
        self.upsampler = GpuSwrUpsampler48kTo192k(
            self.ctx.cuda,
            channels=self.args.channels,
            max_in_chunk_frames=self.in_chunk_frames,
            allocate_output=True,
            align_output_frames=self.frames_per_window,
        )
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if self.upsampler is not None:
                self.upsampler.cleanup(self.ctx.cuda)
                self.upsampler = None
        finally:
            if self.reader is not None:
                self.reader.__exit__(exc_type, exc, tb)

    def _yield_device_output(self, dev_ptr: int, out_frames: int):
        host_ptr = ctypes.addressof(ctypes.c_char.from_buffer(self.host_buffer))
        offset_frames = 0
        while offset_frames < out_frames:
            take_frames = min(self.max_out_frames, out_frames - offset_frames)
            take_bytes = take_frames * self.out_frame_bytes
            src_ptr = ctypes.c_void_p(int(dev_ptr) + offset_frames * self.out_frame_bytes)
            chk(
                self.ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(host_ptr), src_ptr, take_bytes),
                'cuMemcpyDtoH(swr up stats)',
            )
            chunk = FrameChunk(
                this_bytes=take_bytes,
                this_frames=take_frames,
                done_bytes=self.done_bytes,
                frame_offset=self.frame_offset,
            )
            self.done_bytes += take_bytes
            self.frame_offset += take_frames
            offset_frames += take_frames
            yield chunk

    def __iter__(self):
        for in_chunk in self.reader:
            in_ptr = getattr(in_chunk, 'payload_ptr', 0) or ctypes.addressof(ctypes.c_char.from_buffer(self.reader.host_buffer))
            dev_ptr, out_frames = self.upsampler.process_host_chunk(
                self.ctx,
                None,
                host_f32_ptr=in_ptr,
                in_frames=in_chunk.this_frames,
                is_final=False,
            )
            if out_frames > 0:
                yield from self._yield_device_output(dev_ptr, out_frames)
        dev_ptr, out_frames = self.upsampler.process_host_chunk(
            self.ctx,
            None,
            host_f32_ptr=0,
            in_frames=0,
            is_final=True,
        )
        if out_frames > 0:
            yield from self._yield_device_output(dev_ptr, out_frames)
