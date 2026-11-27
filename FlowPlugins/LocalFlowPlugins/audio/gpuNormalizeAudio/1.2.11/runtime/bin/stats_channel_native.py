import array
import ctypes
import os
import time

from cuda_driver import chk
from native_library_image import load_native_library
from runtime_env import env_present_not_false, env_string
from stats_q_sums import combine_channel_sums
from stats_source_audit import _audit_ffmpeg_input_metrics, _finish_source_sum_audit
from stats_source_precompute_stage import _run_source_exact_precompute_stage
from stats_source_stage import (
    _apply_streaming_size_update,
    _trim_source_exact_stage,
    _trim_source_exact_stage_fixed,
)
from stream_ingress_resample import frame_chunk_reader_for


_NATIVE_LIB = None


def _native_stats_explicitly_enabled():
    return env_present_not_false('LOUDNORM_GPU_CHANNEL_STATS_CPU_NATIVE')


def _native_lib_path():
    return env_string(
        'LOUDNORM_GPU_CHANNEL_STATS_NATIVE_LIB',
        os.path.join(os.path.dirname(os.path.abspath(__file__)), 'opx_loudnorm_channel_stats.so'),
    )


def _load_native_lib():
    global _NATIVE_LIB
    if _NATIVE_LIB is not None:
        return _NATIVE_LIB
    lib = load_native_library(_native_lib_path())
    fn = lib.opx_loudnorm_channel_stats_f64_process
    fn.argtypes = [
        ctypes.POINTER(ctypes.c_double),
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_uint32),
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_double),
    ]
    fn.restype = ctypes.c_int
    offset_fn = lib.opx_loudnorm_channel_stats_f64_process_offset
    offset_fn.argtypes = [
        ctypes.POINTER(ctypes.c_double),
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_uint32),
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_double),
    ]
    offset_fn.restype = ctypes.c_int
    output_fn = lib.opx_loudnorm_output_sums_f64_process
    output_fn.argtypes = [
        ctypes.POINTER(ctypes.c_double),
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_uint32),
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_double),
    ]
    output_fn.restype = ctypes.c_int
    swr48k_fn = lib.opx_loudnorm_channel_stats_48k_f32_to_192k_process
    swr48k_fn.argtypes = [
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_uint32,
        ctypes.c_uint64,
        ctypes.c_uint64,
        ctypes.c_uint64,
        ctypes.c_uint64,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_float),
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_uint32),
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_double),
    ]
    swr48k_fn.restype = ctypes.c_int
    swr48k_slice_fn = lib.opx_loudnorm_swr_48k_f32_to_192k_f64_slice
    swr48k_slice_fn.argtypes = [
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_uint32,
        ctypes.c_uint64,
        ctypes.c_uint64,
        ctypes.c_uint64,
        ctypes.c_uint64,
        ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_float),
        ctypes.POINTER(ctypes.c_double),
    ]
    swr48k_slice_fn.restype = ctypes.c_int
    try:
        gain_fn = lib.opx_loudnorm_gain_plan_f64_process
    except AttributeError:
        gain_fn = None
    if gain_fn is not None:
        gain_fn.argtypes = [
            ctypes.POINTER(ctypes.c_double),
            ctypes.c_uint32,
            ctypes.c_uint32,
            ctypes.c_float,
            ctypes.c_float,
            ctypes.c_float,
            ctypes.POINTER(ctypes.c_double),
            ctypes.POINTER(ctypes.c_double),
            ctypes.c_float,
            ctypes.c_float,
            ctypes.c_float,
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_float),
            ctypes.POINTER(ctypes.c_float),
            ctypes.POINTER(ctypes.c_float),
        ]
        gain_fn.restype = ctypes.c_int
    _NATIVE_LIB = lib
    return lib


def _array_ptr(values, ctype):
    return ctypes.cast(ctypes.c_void_p(values.buffer_info()[0]), ctypes.POINTER(ctype))


def _copy_filter_coeffs(ctx):
    b = array.array('d', [0.0]) * 5
    a = array.array('d', [0.0]) * 5
    chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(b.buffer_info()[0]), ctx.buffers.d_b, 5 * 8), 'cuMemcpyDtoH(native filter_b)')
    chk(ctx.cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(a.buffer_info()[0]), ctx.buffers.d_a, 5 * 8), 'cuMemcpyDtoH(native filter_a)')
    return b, a


def init_native_output_sums(ctx):
    return {
        'sums': array.array('d', [0.0]) * ctx.cfg.input_shape.windows,
        'state_i': array.array('I', [0]) * 2,
        'state_d': array.array('d', [0.0]) * (ctx.args.channels * 4 + 1),
        'b': None,
        'a': None,
    }


def run_native_output_sums_chunk(ctx, native_state, payload_ptr, frames, frame_offset, *, copy_to_device=True):
    if frames <= 0:
        return 0.0
    lib = _load_native_lib()
    if native_state['b'] is None or native_state['a'] is None:
        native_state['b'], native_state['a'] = _copy_filter_coeffs(ctx)
    sums = native_state['sums']
    state_i = native_state['state_i']
    state_d = native_state['state_d']
    t0 = time.perf_counter()
    code = lib.opx_loudnorm_output_sums_f64_process(
        ctypes.cast(ctypes.c_void_p(payload_ptr), ctypes.POINTER(ctypes.c_double)),
        ctypes.c_uint32(frames),
        ctypes.c_uint32(ctx.args.channels),
        ctypes.c_uint32(ctx.cfg.input_shape.frames_per_window),
        ctypes.c_uint32(frame_offset),
        _array_ptr(sums, ctypes.c_double),
        _array_ptr(state_i, ctypes.c_uint32),
        _array_ptr(state_d, ctypes.c_double),
        _array_ptr(native_state['b'], ctypes.c_double),
        _array_ptr(native_state['a'], ctypes.c_double),
    )
    dt = time.perf_counter() - t0
    if code != 0:
        raise RuntimeError(f'native output sums failed with code {code}')
    if copy_to_device:
        chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_channel_sums, ctypes.c_void_p(sums.buffer_info()[0]), ctx.cfg.input_shape.windows * 8), 'cuMemcpyHtoD(native first-pass output sums)')
    return dt


def native_channel_stats_supported(ctx, source_stage_config):
    cfg = ctx.cfg
    if not getattr(cfg.exact, 'exact_channel_stats_cpu_native', False):
        return False
    try:
        _load_native_lib()
    except (OSError, AttributeError) as exc:
        if _native_stats_explicitly_enabled():
            raise RuntimeError(f'native channel stats requested but unavailable: {exc}') from exc
        return False
    if cfg.sizing.exact_channel_stats_combined_peaks:
        raise RuntimeError('native channel stats does not support combined peaks')
    if cfg.exact.exact_stats_parallel_peaks or cfg.exact.exact_stats_async_parallel_peaks:
        raise RuntimeError('native channel stats does not support separate peak kernels')
    if cfg.exact.exact_stats_async_pipeline or cfg.exact.exact_stats_async_pinned_pipeline:
        raise RuntimeError('native channel stats does not support CUDA stats async pipeline')
    if getattr(cfg.exact, 'exact_channel_stats_checkpoint_replay', False):
        raise RuntimeError('native channel stats does not support checkpoint replay')
    if getattr(cfg.exact, 'exact_channel_stats_warp', False) or getattr(cfg.exact, 'exact_channel_stats_no_peaks', False) or getattr(cfg.exact, 'exact_channel_stats_unroll4', False):
        raise RuntimeError('native channel stats cannot be combined with alternate channel kernels')
    if source_stage_config.use_source_device_energy or source_stage_config.use_source_device_input:
        return False
    if cfg.source.source_channel_hist4_boundary or cfg.source.source_channel_short_boundary or getattr(cfg.source, 'source_channel_short_raw_boundary', False):
        raise RuntimeError('native channel stats does not support source correction modes that read channel sums mid-stage')
    return True


def _run_native_channel_stats_48k_f32_pass(
    ctx,
    result,
    lib,
    channel_sums,
    peaks,
    states,
    channel_sums_ptr,
    peaks_ptr,
    states_ptr,
    b_ptr,
    a_ptr,
    audit_tail,
):
    from stream_processes import close_decode_pass, start_decode_pass
    from swr_input_upsample import (
        SWR_48K_TO_192K_CENTER,
        SWR_48K_TO_192K_PHASES,
        SWR_48K_TO_192K_RIGHT_RADIUS,
        SWR_48K_TO_192K_TAPS,
        build_swr_48k_to_192k_filters,
        swr_48k_to_192k_ready_output_end,
    )

    args = ctx.args
    cfg = ctx.cfg
    in_frame_bytes = args.channels * 4
    out_frame_bytes = args.channels * 8
    fpw = cfg.input_shape.frames_per_window
    filt = build_swr_48k_to_192k_filters()
    filt_arr = (ctypes.c_float * (SWR_48K_TO_192K_PHASES * SWR_48K_TO_192K_TAPS))(*filt)
    filt_ptr = ctypes.cast(filt_arr, ctypes.POINTER(ctypes.c_float))

    read_chunk_frames = 48000
    read_chunk_bytes = read_chunk_frames * in_frame_bytes
    halo_left = SWR_48K_TO_192K_CENTER + 1
    audit_tail_out_frames = (cfg.sizing.audit_input_tail_bytes // out_frame_bytes) if audit_tail is not None else 0
    keep_extra_in_frames = ((audit_tail_out_frames + 3) // 4) + halo_left + SWR_48K_TO_192K_RIGHT_RADIUS + 4 if audit_tail_out_frames > 0 else halo_left
    window_buf = bytearray()
    window_start_in_frame = 0
    received_in_frames = 0
    emitted_out_frames = 0
    max_windows = len(peaks)

    label = 'streaming decode native channel stats 48k f32'
    proc, handle = start_decode_pass(args, cfg.root.streaming_io, cfg.input_shape.decode_command, label)
    try:
        while True:
            raw = handle.read(read_chunk_bytes)
            if not raw:
                break
            window_buf.extend(raw)
            usable_bytes = (len(window_buf) // in_frame_bytes) * in_frame_bytes
            if usable_bytes == 0:
                continue
            window_in_frames = usable_bytes // in_frame_bytes
            received_in_frames = window_start_in_frame + window_in_frames
            ready_end = swr_48k_to_192k_ready_output_end(received_in_frames, None, is_final=False)
            ready_end = (ready_end // 4) * 4
            if ready_end > emitted_out_frames:
                last_w = (ready_end - 1) // fpw
                if last_w >= max_windows:
                    raise RuntimeError(f'native 48k channel stats window overflow: {last_w} >= {max_windows}')
                buf_ptr = ctypes.cast(ctypes.addressof(ctypes.c_char.from_buffer(window_buf)), ctypes.POINTER(ctypes.c_float))
                stage_t0 = time.perf_counter()
                code = lib.opx_loudnorm_channel_stats_48k_f32_to_192k_process(
                    buf_ptr,
                    ctypes.c_uint32(window_in_frames),
                    ctypes.c_uint64(window_start_in_frame),
                    ctypes.c_uint64(received_in_frames),
                    ctypes.c_uint64(emitted_out_frames),
                    ctypes.c_uint64(ready_end),
                    ctypes.c_uint32(args.channels),
                    ctypes.c_uint32(fpw),
                    filt_ptr,
                    channel_sums_ptr,
                    peaks_ptr,
                    states_ptr,
                    b_ptr,
                    a_ptr,
                )
                native_dt = time.perf_counter() - stage_t0
                if code != 0:
                    raise RuntimeError(f'native 48k channel stats failed with code {code}')
                result.stats_sums_kernel_time += native_dt
                result.stats_sums_wall_time += native_dt
                emitted_out_frames = ready_end

                keep_from_in = max(window_start_in_frame, received_in_frames - keep_extra_in_frames)
                keep_from_in = min(keep_from_in, max(window_start_in_frame, (emitted_out_frames // 4) - halo_left))
                drop_in = keep_from_in - window_start_in_frame
                if drop_in > 0:
                    del window_buf[:drop_in * in_frame_bytes]
                    window_start_in_frame = keep_from_in
                ctx.emit_progress('stats_sums', 0.70 * ((emitted_out_frames * out_frame_bytes) / float(max(1, cfg.input_shape.nbytes))))

        if len(window_buf) % in_frame_bytes != 0:
            raise RuntimeError('streaming native 48k channel stats ended with a partial frame')
        window_in_frames = len(window_buf) // in_frame_bytes
        received_in_frames = window_start_in_frame + window_in_frames
        final_end = swr_48k_to_192k_ready_output_end(received_in_frames, received_in_frames, is_final=True)
        if final_end > emitted_out_frames:
            last_w = (final_end - 1) // fpw
            if last_w >= max_windows:
                raise RuntimeError(f'native 48k channel stats final window overflow: {last_w} >= {max_windows}')
            buf_ptr = ctypes.cast(ctypes.addressof(ctypes.c_char.from_buffer(window_buf)), ctypes.POINTER(ctypes.c_float))
            stage_t0 = time.perf_counter()
            code = lib.opx_loudnorm_channel_stats_48k_f32_to_192k_process(
                buf_ptr,
                ctypes.c_uint32(window_in_frames),
                ctypes.c_uint64(window_start_in_frame),
                ctypes.c_uint64(received_in_frames),
                ctypes.c_uint64(emitted_out_frames),
                ctypes.c_uint64(final_end),
                ctypes.c_uint32(args.channels),
                ctypes.c_uint32(fpw),
                filt_ptr,
                channel_sums_ptr,
                peaks_ptr,
                states_ptr,
                b_ptr,
                a_ptr,
            )
            native_dt = time.perf_counter() - stage_t0
            if code != 0:
                raise RuntimeError(f'native 48k channel stats final flush failed with code {code}')
            result.stats_sums_kernel_time += native_dt
            result.stats_sums_wall_time += native_dt
            emitted_out_frames = final_end

        if audit_tail is not None and audit_tail_out_frames > 0 and emitted_out_frames > 0:
            tail_frames = min(audit_tail_out_frames, emitted_out_frames)
            tail_start = emitted_out_frames - tail_frames
            tail_buf = bytearray(tail_frames * out_frame_bytes)
            buf_ptr = ctypes.cast(ctypes.addressof(ctypes.c_char.from_buffer(window_buf)), ctypes.POINTER(ctypes.c_float))
            out_ptr = ctypes.cast(ctypes.addressof(ctypes.c_char.from_buffer(tail_buf)), ctypes.POINTER(ctypes.c_double))
            code = lib.opx_loudnorm_swr_48k_f32_to_192k_f64_slice(
                buf_ptr,
                ctypes.c_uint32(window_in_frames),
                ctypes.c_uint64(window_start_in_frame),
                ctypes.c_uint64(received_in_frames),
                ctypes.c_uint64(tail_start),
                ctypes.c_uint64(emitted_out_frames),
                ctypes.c_uint32(args.channels),
                filt_ptr,
                out_ptr,
            )
            if code != 0:
                raise RuntimeError(f'native 48k audit tail upsample failed with code {code}')
            audit_tail.clear()
            audit_tail.extend(tail_buf)
    finally:
        close_decode_pass(proc, handle, label)

    _apply_streaming_size_update(ctx, result, emitted_out_frames * out_frame_bytes)


def run_native_channel_stats_pass(ctx, result, source_stage_config):
    args = ctx.args
    cfg = ctx.cfg
    lib = _load_native_lib()
    host_in = ctx.host_io.host_in
    host_in_ptr = ctx.host_io.host_in_ptr
    channel_sums = array.array('d', [0.0]) * (result.windows * args.channels)
    peaks = array.array('I', [0]) * result.windows
    states = array.array('d', [0.0]) * (args.channels * 4)
    source_start_states = array.array('d', [0.0]) * (result.windows * args.channels * 4) if ctx.buffers.d_source_start_states.value else None
    b_coeffs, a_coeffs = _copy_filter_coeffs(ctx)
    channel_sums_ptr = _array_ptr(channel_sums, ctypes.c_double)
    peaks_ptr = _array_ptr(peaks, ctypes.c_uint32)
    states_ptr = _array_ptr(states, ctypes.c_double)
    source_states_ptr = _array_ptr(source_start_states, ctypes.c_double) if source_start_states is not None else ctypes.POINTER(ctypes.c_double)()
    b_ptr = _array_ptr(b_coeffs, ctypes.c_double)
    a_ptr = _array_ptr(a_coeffs, ctypes.c_double)

    def copy_source_start_states(ready_windows):
        if source_start_states is None or ready_windows <= 0:
            return
        copy_bytes = ready_windows * args.channels * 4 * 8
        copy_t0 = time.perf_counter()
        chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_source_start_states, ctypes.c_void_p(source_start_states.buffer_info()[0]), copy_bytes), 'cuMemcpyHtoD(native staged source_start_states)')
        copy_dt = time.perf_counter() - copy_t0
        result.stats_sums_h2d_time += copy_dt
        result.total_h2d_time += copy_dt

    source_stage = source_stage_config.source_stage
    source_stage_active_bytes = 0
    audit_tail = source_stage_config.audit_tail
    source_stage_start_frame = 0
    next_source_window = 0
    source_overlap_frames = source_stage_config.source_overlap_frames
    use_source_fixed_buffer = source_stage_config.use_source_fixed_buffer

    if getattr(args, 'swr_upsample_48k_f32', False) and source_stage is None and args.rate == 192000 and cfg.root.streaming_io:
        _run_native_channel_stats_48k_f32_pass(
            ctx,
            result,
            lib,
            channel_sums,
            peaks,
            states,
            channel_sums_ptr,
            peaks_ptr,
            states_ptr,
            b_ptr,
            a_ptr,
            audit_tail,
        )
    else:
        with frame_chunk_reader_for(
            ctx,
            cfg.input_shape.decode_command,
            'streaming decode native channel stats',
            host_in,
            chunk_bytes=cfg.sizing.stats_chunk_bytes,
            partial_frame_error='streaming native channel stats ended with a partial frame',
            staging_label='streaming native channel stats staging',
            short_read_error='short input read during native channel stats',
        ) as chunks:
            for chunk in chunks:
                chunk_ptr = chunk.payload_ptr if getattr(chunk, 'payload_ptr', 0) else host_in_ptr
                chunk_view = memoryview(chunk.payload) if getattr(chunk, 'payload_ptr', 0) else memoryview(host_in)[:chunk.this_bytes]
                stage_t0 = time.perf_counter()
                code = lib.opx_loudnorm_channel_stats_f64_process(
                    ctypes.cast(ctypes.c_void_p(chunk_ptr), ctypes.POINTER(ctypes.c_double)),
                    ctypes.c_uint32(chunk.this_frames),
                    ctypes.c_uint32(args.channels),
                    ctypes.c_uint32(cfg.input_shape.frames_per_window),
                    ctypes.c_uint32(chunk.frame_offset),
                    channel_sums_ptr,
                    peaks_ptr,
                    states_ptr,
                    source_states_ptr,
                    b_ptr,
                    a_ptr,
                )
                native_dt = time.perf_counter() - stage_t0
                if code != 0:
                    raise RuntimeError(f'native channel stats failed with code {code}')
                result.stats_sums_kernel_time += native_dt
                result.stats_sums_wall_time += native_dt

                if audit_tail is not None:
                    audit_tail.extend(chunk_view)
                    excess = len(audit_tail) - cfg.sizing.audit_input_tail_bytes
                    if excess > 0:
                        del audit_tail[:excess]
                if source_stage is not None:
                    if use_source_fixed_buffer:
                        next_stage_bytes = source_stage_active_bytes + chunk.this_bytes
                        if next_stage_bytes > len(source_stage):
                            raise RuntimeError(f'source fixed staging exceeded: need={next_stage_bytes} capacity={len(source_stage)}')
                        memoryview(source_stage)[source_stage_active_bytes:next_stage_bytes] = chunk_view
                        source_stage_active_bytes = next_stage_bytes
                        stage_frames = source_stage_active_bytes // cfg.sizing.frame_bytes
                    else:
                        source_stage.extend(chunk_view)
                        stage_frames = len(source_stage) // cfg.sizing.frame_bytes
                    stage_end_frame = source_stage_start_frame + stage_frames
                    full_ready_windows = min(result.windows, stage_end_frame // cfg.input_shape.frames_per_window)
                    while full_ready_windows - next_source_window >= cfg.sizing.source_precompute_windows:
                        ready_windows = next_source_window + cfg.sizing.source_precompute_windows
                        copy_source_start_states(ready_windows)
                        next_source_window = _run_source_exact_precompute_stage(
                            ctx,
                            result,
                            source_stage,
                            source_stage_start_frame,
                            next_source_window,
                            ready_windows,
                            stage_active_bytes=source_stage_active_bytes if use_source_fixed_buffer else None,
                        )
                        ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.input_shape.nbytes)))
                        if use_source_fixed_buffer:
                            source_stage_start_frame, source_stage_active_bytes = _trim_source_exact_stage_fixed(
                                source_stage,
                                source_stage_active_bytes,
                                source_stage_start_frame,
                                next_source_window,
                                source_overlap_frames,
                                cfg.sizing.frame_bytes,
                                cfg.input_shape.frames_per_window,
                            )
                        else:
                            source_stage_start_frame = _trim_source_exact_stage(
                                source_stage,
                                source_stage_start_frame,
                                next_source_window,
                                source_overlap_frames,
                                cfg.sizing.frame_bytes,
                                cfg.input_shape.frames_per_window,
                            )
                ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.input_shape.nbytes)))
            if cfg.root.streaming_io:
                _apply_streaming_size_update(ctx, result, chunks.done_bytes)
            if source_stage is not None:
                if result.windows > next_source_window:
                    copy_source_start_states(result.windows)
                    next_source_window = _run_source_exact_precompute_stage(
                        ctx,
                        result,
                        source_stage,
                        source_stage_start_frame,
                        next_source_window,
                        result.windows,
                        stage_active_bytes=source_stage_active_bytes if use_source_fixed_buffer else None,
                    )
                if next_source_window != result.windows:
                    raise RuntimeError(f'fused source exact precompute incomplete: windows={next_source_window} expected={result.windows}')
                _finish_source_sum_audit(ctx)

    copy_t0 = time.perf_counter()
    chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_start_states, ctypes.c_void_p(channel_sums.buffer_info()[0]), len(channel_sums) * 8), 'cuMemcpyHtoD(native channel_sums)')
    chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_peaks, ctypes.c_void_p(peaks.buffer_info()[0]), len(peaks) * 4), 'cuMemcpyHtoD(native peaks)')
    if source_start_states is not None:
        chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_source_start_states, ctypes.c_void_p(source_start_states.buffer_info()[0]), len(source_start_states) * 8), 'cuMemcpyHtoD(native source_start_states)')
    copy_dt = time.perf_counter() - copy_t0
    result.stats_sums_h2d_time += copy_dt
    result.total_h2d_time += copy_dt

    combine_channel_sums(ctx, result, source_arg=ctx.bindings.start_states_arg, label='combine-native-channel-sums')
    if audit_tail is not None:
        cfg._ffmpeg_input_metric_final_states = array.array('d', states)
        _audit_ffmpeg_input_metrics(ctx, result, audit_tail)
    ctx.emit_progress('stats_sums', 0.70)
