from __future__ import annotations

import ctypes
from types import SimpleNamespace

from cuda_driver import chk


def load_kernel_set(cuda, module, input_format, output_format, exact_limiter_active, exact_stats_stream, exact_prefix_channel_stats, apply_ffmpeg_timing, parallel_final_apply, exact_prefill_output):
    q_fn = ctypes.c_void_p()
    sums_fn = ctypes.c_void_p()
    exact_sums_fn = ctypes.c_void_p()
    channel_sums_fn = ctypes.c_void_p()
    peak_fn = ctypes.c_void_p()
    prefix_channel_sums_fn = ctypes.c_void_p()
    combine_sums_fn = ctypes.c_void_p()
    gain_fn = ctypes.c_void_p()
    metrics_fn = ctypes.c_void_p()
    apply_fn = ctypes.c_void_p()
    prefill_apply_fn = ctypes.c_void_p()
    q_kernel_name = b'kweight_window_q_f64_kernel' if input_format == 'f64le' else b'kweight_window_q_kernel'
    sums_kernel_name = b'kweight_window_sums_f64_kernel' if input_format == 'f64le' else b'kweight_window_sums_kernel'
    chk(cuda.cuModuleGetFunction(ctypes.byref(q_fn), module, q_kernel_name), f'cuModuleGetFunction({q_kernel_name.decode()})')
    chk(cuda.cuModuleGetFunction(ctypes.byref(sums_fn), module, sums_kernel_name), f'cuModuleGetFunction({sums_kernel_name.decode()})')
    if exact_stats_stream:
        chk(cuda.cuModuleGetFunction(ctypes.byref(exact_sums_fn), module, b'kweight_window_sums_f64_stream_kernel'), 'cuModuleGetFunction(exact-sums)')
    if exact_limiter_active and input_format == 'f64le' and not exact_stats_stream:
        chk(cuda.cuModuleGetFunction(ctypes.byref(channel_sums_fn), module, b'kweight_window_sums_f64_channel_kernel'), 'cuModuleGetFunction(channel-sums)')
        chk(cuda.cuModuleGetFunction(ctypes.byref(peak_fn), module, b'window_peaks_f64_kernel'), 'cuModuleGetFunction(window-peaks)')
        chk(cuda.cuModuleGetFunction(ctypes.byref(combine_sums_fn), module, b'combine_channel_sums_kernel'), 'cuModuleGetFunction(combine-channel-sums)')
        if exact_prefix_channel_stats:
            chk(cuda.cuModuleGetFunction(ctypes.byref(prefix_channel_sums_fn), module, b'kweight_window_channel_sums_f64_prefix_kernel'), 'cuModuleGetFunction(prefix-channel-sums)')
    chk(cuda.cuModuleGetFunction(ctypes.byref(gain_fn), module, b'source_port_gain_kernel'), 'cuModuleGetFunction(gain)')
    has_metrics_kernel = cuda.cuModuleGetFunction(ctypes.byref(metrics_fn), module, b'source_port_metrics_kernel') == 0
    if exact_limiter_active:
        apply_kernel_name = b'apply_plan_f64_io_ffmpeg_feedback_limiter_stream_kernel'
    elif parallel_final_apply:
        apply_kernel_name = b'apply_plan_f64_io_ffmpeg_timing_final_kernel'
    elif apply_ffmpeg_timing:
        apply_kernel_name = b'apply_plan_f64_io_ffmpeg_timing_kernel'
    elif input_format == 'f64le':
        apply_kernel_name = b'apply_plan_f64_io_kernel'
    else:
        apply_kernel_name = b'apply_plan_f64_kernel' if output_format == 'f64le' else b'apply_plan_kernel'
    chk(cuda.cuModuleGetFunction(ctypes.byref(apply_fn), module, apply_kernel_name), f'cuModuleGetFunction({apply_kernel_name.decode()})')
    if exact_prefill_output:
        chk(cuda.cuModuleGetFunction(ctypes.byref(prefill_apply_fn), module, b'apply_plan_f64_io_ffmpeg_timing_final_window_kernel'), 'cuModuleGetFunction(apply_plan_f64_io_ffmpeg_timing_final_window_kernel)')
    return SimpleNamespace(**locals())
