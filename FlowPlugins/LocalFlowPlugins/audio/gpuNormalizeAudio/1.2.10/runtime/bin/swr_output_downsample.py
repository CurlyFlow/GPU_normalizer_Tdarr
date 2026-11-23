"""GPU-owned exact FFmpeg libswresample 192 kHz f64 -> 96 kHz f32le streaming downsampler."""

from __future__ import annotations

import ctypes
import math
import time

from cuda_driver import chk
from kernel_args import build_swr_downsample_192k_to_96k_args


SWR_192K_TO_96K_TAPS = 66
SWR_192K_TO_96K_FILTER_LEN = 68
SWR_192K_TO_96K_HALO_FRAMES = 68

_BESSEL_P1 = (
    -2.2335582639474375249e+15,
    -5.5050369673018427753e+14,
    -3.2940087627407749166e+13,
    -8.4925101247114157499e+11,
    -1.1912746104985237192e+10,
    -1.0313066708737980747e+08,
    -5.9545626019847898221e+05,
    -2.4125195876041896775e+03,
    -7.0935347449210549190e+00,
    -1.5453977791786851041e-02,
    -2.5172644670688975051e-05,
    -3.0517226450451067446e-08,
    -2.6843448573468483278e-11,
    -1.5982226675653184646e-14,
    -5.2487866627945699800e-18,
)
_BESSEL_Q1 = (
    -2.2335582639474375245e+15,
    7.8858692566751002988e+12,
    -1.2207067397808979846e+10,
    1.0377081058062166144e+07,
    -4.8527560179962773045e+03,
    1.0,
)


def _eval_poly(coeffs, value):
    acc = coeffs[-1]
    for coeff in reversed(coeffs[:-1]):
        acc = acc * value + coeff
    return acc


def _av_bessel_i0_small(value):
    if value == 0.0:
        return 1.0
    squared = value * value
    return _eval_poly(_BESSEL_P1, squared) / _eval_poly(_BESSEL_Q1, squared)


def build_swr_192k_to_96k_filter():
    """Reproduce FFmpeg 7.1.2 libswresample build_filter() for 192k->96k DBLP."""
    factor = 96000.0 * 0.97 / 192000.0
    tap_count = SWR_192K_TO_96K_TAPS
    center = (tap_count - 1) // 2
    tab = []
    norm = 0.0
    for idx in range(tap_count):
        x = math.pi * float(idx - center) * factor
        val = 1.0 if x == 0.0 else math.sin(x) / x
        w = 2.0 * x / (factor * tap_count * math.pi)
        val *= _av_bessel_i0_small(9.0 * math.sqrt(max(1.0 - w * w, 0.0)))
        tab.append(val)
        norm += val
    return tuple(val / norm for val in tab) + (0.0, 0.0)


def swr_192k_to_96k_output_frames(total_source_frames):
    if total_source_frames <= 0:
        return 0
    return (int(total_source_frames) + 1) // 2


def swr_ready_output_end(received_frames, total_source_frames, *, is_final):
    if is_final:
        return swr_192k_to_96k_output_frames(total_source_frames)
    if received_frames < SWR_192K_TO_96K_HALO_FRAMES:
        return 0
    return ((received_frames - 36) // 2) + 1


class GpuSwrDownsampler192kTo96k:
    """Streaming GPU 192 kHz f64 -> 96 kHz f32le polyphase FIR downsampler."""

    def __init__(self, cuda, *, channels, max_chunk_frames, total_source_frames):
        if channels < 1 or channels > 64:
            raise RuntimeError(f'Invalid channel count for GPU SWR downsampler: {channels}')
        if total_source_frames < 1:
            raise RuntimeError(f'Invalid total_source_frames for GPU SWR downsampler: {total_source_frames}')
        self.channels = int(channels)
        self.total_source_frames = int(total_source_frames)
        self.in_frame_bytes = self.channels * 8
        self.out_frame_bytes = self.channels * 4
        self.halo_frames = 0
        self.received_frames = 0
        self.emitted_out_frames = 0

        self.stage_capacity_frames = max(int(max_chunk_frames), 1) + SWR_192K_TO_96K_HALO_FRAMES
        self.out_capacity_frames = ((self.stage_capacity_frames + 1) // 2) + 2

        self.d_filter = ctypes.c_void_p()
        self.d_stage = ctypes.c_void_p()
        self.d_halo_tmp = ctypes.c_void_p()
        self.d_out_f32 = ctypes.c_void_p()

        try:
            filt = build_swr_192k_to_96k_filter()
            filt_arr = (ctypes.c_double * SWR_192K_TO_96K_FILTER_LEN)(*filt)
            chk(cuda.cuMemAlloc_v2(ctypes.byref(self.d_filter), ctypes.sizeof(filt_arr)), 'cuMemAlloc(swr filter)')
            chk(cuda.cuMemcpyHtoD_v2(self.d_filter, ctypes.cast(filt_arr, ctypes.c_void_p), ctypes.sizeof(filt_arr)), 'cuMemcpyHtoD(swr filter)')
            chk(cuda.cuMemAlloc_v2(ctypes.byref(self.d_stage), self.stage_capacity_frames * self.in_frame_bytes), 'cuMemAlloc(swr stage)')
            chk(cuda.cuMemAlloc_v2(ctypes.byref(self.d_halo_tmp), SWR_192K_TO_96K_HALO_FRAMES * self.in_frame_bytes), 'cuMemAlloc(swr halo)')
            chk(cuda.cuMemAlloc_v2(ctypes.byref(self.d_out_f32), self.out_capacity_frames * self.out_frame_bytes), 'cuMemAlloc(swr out)')
        except BaseException:
            self.cleanup(cuda)
            raise

    def _ensure_capacity(self, cuda, needed_stage_frames):
        if needed_stage_frames <= self.stage_capacity_frames:
            return
        new_stage_cap = needed_stage_frames
        new_out_cap = ((new_stage_cap + 1) // 2) + 2
        new_stage = ctypes.c_void_p()
        new_out = ctypes.c_void_p()
        chk(cuda.cuMemAlloc_v2(ctypes.byref(new_stage), new_stage_cap * self.in_frame_bytes), 'cuMemAlloc(swr stage grow)')
        try:
            chk(cuda.cuMemAlloc_v2(ctypes.byref(new_out), new_out_cap * self.out_frame_bytes), 'cuMemAlloc(swr out grow)')
        except BaseException:
            cuda.cuMemFree_v2(new_stage)
            raise
        if self.halo_frames > 0:
            chk(cuda.cuMemcpyDtoD_v2(new_stage, self.d_stage, self.halo_frames * self.in_frame_bytes), 'cuMemcpyDtoD(swr stage grow)')
        cuda.cuMemFree_v2(self.d_stage)
        cuda.cuMemFree_v2(self.d_out_f32)
        self.d_stage = new_stage
        self.d_out_f32 = new_out
        self.stage_capacity_frames = new_stage_cap
        self.out_capacity_frames = new_out_cap

    def process_chunk(self, ctx, result, *, src_dev_ptr, chunk_frames, is_final):
        cuda = ctx.cuda
        chunk_frames = int(chunk_frames)
        if chunk_frames < 0:
            raise RuntimeError(f'Negative chunk_frames in GPU SWR downsampler: {chunk_frames}')
        window_frames = self.halo_frames + chunk_frames
        self._ensure_capacity(cuda, window_frames)

        if chunk_frames > 0:
            dst_ptr = ctypes.c_void_p(self.d_stage.value + self.halo_frames * self.in_frame_bytes)
            chk(
                cuda.cuMemcpyDtoD_v2(dst_ptr, ctypes.c_void_p(int(src_dev_ptr)), chunk_frames * self.in_frame_bytes),
                'cuMemcpyDtoD(swr stage append)',
            )
        window_start_frame = self.received_frames - self.halo_frames
        self.received_frames += chunk_frames
        if is_final and self.received_frames != self.total_source_frames:
            raise RuntimeError(
                f'GPU SWR downsampler EOF frame mismatch: received={self.received_frames} expected={self.total_source_frames}'
            )

        ready_end = swr_ready_output_end(self.received_frames, self.total_source_frames, is_final=is_final)
        output_count = max(0, ready_end - self.emitted_out_frames)
        out_bytes = 0
        if output_count > 0:
            input_arg = ctypes.c_uint64(self.d_stage.value)
            filter_arg = ctypes.c_uint64(self.d_filter.value)
            output_arg = ctypes.c_uint64(self.d_out_f32.value)
            window_start_arg = ctypes.c_uint64(window_start_frame)
            total_source_arg = ctypes.c_uint64(self.total_source_frames)
            output_start_arg = ctypes.c_uint64(self.emitted_out_frames)
            output_count_arg = ctypes.c_uint64(output_count)
            channels_arg = ctypes.c_uint32(self.channels)
            params = build_swr_downsample_192k_to_96k_args(
                input_arg,
                filter_arg,
                output_arg,
                window_start_arg,
                total_source_arg,
                output_start_arg,
                output_count_arg,
                channels_arg,
            )
            total_values = output_count * self.channels
            grid = (total_values + 255) // 256
            t0 = time.perf_counter()
            chk(
                cuda.cuLaunchKernel(ctx.kernels.swr_downsample_fn, grid, 1, 1, 256, 1, 1, 0, None, params, None),
                'cuLaunchKernel(swr_downsample_192k_to_96k)',
            )
            chk(cuda.cuCtxSynchronize(), 'cuCtxSynchronize(swr_downsample_192k_to_96k)')
            result.apply_kernel_time += time.perf_counter() - t0
            self.emitted_out_frames += output_count
            out_bytes = output_count * self.out_frame_bytes

        if not is_final:
            keep = min(window_frames, SWR_192K_TO_96K_HALO_FRAMES)
            if keep > 0:
                offset = (window_frames - keep) * self.in_frame_bytes
                if offset > 0:
                    keep_bytes = keep * self.in_frame_bytes
                    src_tail = ctypes.c_void_p(self.d_stage.value + offset)
                    chk(cuda.cuMemcpyDtoD_v2(self.d_halo_tmp, src_tail, keep_bytes), 'cuMemcpyDtoD(swr halo save)')
                    chk(cuda.cuMemcpyDtoD_v2(self.d_stage, self.d_halo_tmp, keep_bytes), 'cuMemcpyDtoD(swr halo restore)')
            self.halo_frames = keep
        else:
            self.halo_frames = 0

        return self.d_out_f32.value, out_bytes

    def cleanup(self, cuda):
        for attr in ('d_filter', 'd_stage', 'd_halo_tmp', 'd_out_f32'):
            ptr = getattr(self, attr, None)
            if ptr is not None and getattr(ptr, 'value', 0):
                cuda.cuMemFree_v2(ptr)
                setattr(self, attr, ctypes.c_void_p())
