"""GPU-owned af_loudnorm short FIRST_FRAME, using the existing apply I/O session."""

import ctypes
import time
from contextlib import ExitStack

from cuda_driver import chk
from kernel_args import build_short_apply_args, build_short_filter_args, build_short_gain_args


def is_short_first_frame(args, cfg):
    threshold = args.rate * 3
    threshold += threshold % 2
    return (args.input_format == 'f64le' and args.output_format == 'f64le'
            and not cfg.loudnorm_mode.linear_mode
            and 0 < cfg.input_shape.total_frames < threshold)


def read_short_input(ctx, state, host):
    """Drain the same second decode/prefetch owner, never start another decode."""
    view = memoryview(host).cast('B')
    frame_bytes = ctx.args.channels * 8
    chunk_frames = min(ctx.cfg.sizing.chunk_bytes, len(ctx.host_io.host_in)) // frame_bytes
    if chunk_frames < 1:
        raise RuntimeError('Short FIRST_FRAME has no complete input staging frame')
    for frame in range(0, ctx.cfg.input_shape.total_frames, chunk_frames):
        count = min(chunk_frames, ctx.cfg.input_shape.total_frames - frame) * frame_bytes
        offset = frame * frame_bytes
        if state.exact_stream_window is not None:
            if state.exact_stream_window.stage(frame, count // frame_bytes) != count:
                raise RuntimeError('Short FIRST_FRAME prefetch returned incomplete input')
            view[offset:offset + count] = memoryview(ctx.host_io.host_in).cast('B')[:count]
        else:
            read = 0
            while read < count:
                got = state.fi.readinto(view[offset + read:offset + count])
                if not got:
                    raise RuntimeError('Short FIRST_FRAME decode ended before its measured frame count')
                read += got


def run_short_first_frame(ctx, result, state):
    args, cfg, cuda, bindings = ctx.args, ctx.cfg, ctx.cuda, ctx.bindings
    frames, channels = cfg.input_shape.total_frames, args.channels
    if not is_short_first_frame(args, cfg) or not 1 <= channels <= 64:
        raise RuntimeError('Invalid bounded short FIRST_FRAME apply request')
    size = frames * channels * 8
    host = (ctypes.c_ubyte * size)()
    read_short_input(ctx, state, host)
    with ExitStack() as allocations:
        def allocate(count):
            pointer = ctypes.c_void_p()
            chk(cuda.cuMemAlloc_v2(ctypes.byref(pointer), count), 'cuMemAlloc(short FIRST_FRAME)')
            allocations.callback(lambda: chk(cuda.cuMemFree_v2(pointer), 'cuMemFree(short FIRST_FRAME)'))
            return ctypes.c_uint64(pointer.value)

        source, energy, output = allocate(size), allocate(size), allocate(size)
        peak, gain = allocate(channels * 8), allocate(8)
        t0 = time.perf_counter()
        chk(cuda.cuMemcpyHtoD_v2(ctypes.c_void_p(source.value), ctypes.cast(host, ctypes.c_void_p), size), 'cuMemcpyHtoD(short)')
        elapsed = time.perf_counter() - t0
        result.apply_h2d_time += elapsed
        result.total_h2d_time += elapsed
        frame_arg, channel_arg, rate_arg = ctypes.c_uint32(frames), ctypes.c_uint32(channels), ctypes.c_uint32(args.rate)
        target_arg, ceiling_arg = ctypes.c_double(args.target_i), ctypes.c_double(10.0 ** (args.target_tp / 20.0))
        sample_arg = ctypes.c_uint32(frames * channels)
        calls = (
            (ctx.kernels.short_filter_fn, (channels + 31) // 32, 32,
             build_short_filter_args(source, energy, peak, frame_arg, channel_arg, rate_arg, bindings.b_arg, bindings.a_arg)),
            (ctx.kernels.short_gain_fn, 1, 1,
             build_short_gain_args(energy, peak, gain, frame_arg, channel_arg, rate_arg,
                                   bindings.hist_energies_arg, bindings.hist_boundaries_arg, target_arg, ceiling_arg)),
            (ctx.kernels.short_apply_fn, (sample_arg.value + 255) // 256, 256,
             build_short_apply_args(source, output, gain, sample_arg)),
        )
        t0 = time.perf_counter()
        for kernel, grid, block, parameters in calls:
            chk(cuda.cuLaunchKernel(kernel, grid, 1, 1, block, 1, 1, 0, None, parameters, None), 'cuLaunchKernel(short FIRST_FRAME)')
        chk(cuda.cuCtxSynchronize(), 'cuCtxSynchronize(short FIRST_FRAME)')
        result.apply_kernel_time += time.perf_counter() - t0
        out_dev_ptr = output.value
        out_size = size
        if state.swr_downsampler is not None:
            out_dev_ptr, out_size = state.swr_downsampler.process_chunk(
                ctx,
                result,
                src_dev_ptr=output.value,
                chunk_frames=frames,
                is_final=True,
            )
        t0 = time.perf_counter()
        chk(cuda.cuMemcpyDtoH_v2(ctypes.cast(host, ctypes.c_void_p), ctypes.c_void_p(out_dev_ptr), out_size), 'cuMemcpyDtoH(short)')
        elapsed = time.perf_counter() - t0
        result.apply_d2h_time += elapsed
        result.total_d2h_time += elapsed
        t0 = time.perf_counter()
        state.fo.write(memoryview(host).cast('B')[:out_size])
        result.apply_write_time += time.perf_counter() - t0
    state.done_bytes = size
    state.frame_offset = frames
    state.active = False
    result.apply_path = 'sync_gpu_short_first_frame'
    result.apply_pinned = 0
    result.apply_stream_count = 1
    ctx.emit_progress('apply', 1.0)
    return True
