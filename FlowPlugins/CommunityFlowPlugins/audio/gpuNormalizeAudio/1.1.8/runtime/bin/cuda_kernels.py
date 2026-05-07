from __future__ import annotations

import ctypes
from types import SimpleNamespace

from cuda_driver import chk


def load_kernel_set(cuda, module, args, cfg):
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
    safe_feedback_energy_fn = ctypes.c_void_p()
    safe_feedback_window_fn = ctypes.c_void_p()
    safe_feedback_stitch_fn = ctypes.c_void_p()
    safe_feedback_fill_fn = ctypes.c_void_p()
    safe_feedback_apply_fn = ctypes.c_void_p()
    input_format = args.input_format
    output_format = args.output_format
    q_kernel_name = b'kweight_window_q_f64_kernel' if input_format == 'f64le' else b'kweight_window_q_kernel'
    sums_kernel_name = b'kweight_window_sums_f64_kernel' if input_format == 'f64le' else b'kweight_window_sums_kernel'
    chk(cuda.cuModuleGetFunction(ctypes.byref(q_fn), module, q_kernel_name), f'cuModuleGetFunction({q_kernel_name.decode()})')
    chk(cuda.cuModuleGetFunction(ctypes.byref(sums_fn), module, sums_kernel_name), f'cuModuleGetFunction({sums_kernel_name.decode()})')
    if cfg.exact_stats_stream:
        chk(cuda.cuModuleGetFunction(ctypes.byref(exact_sums_fn), module, b'kweight_window_sums_f64_stream_kernel'), 'cuModuleGetFunction(exact-sums)')
    if cfg.exact_limiter_active and input_format == 'f64le' and not cfg.exact_stats_stream:
        chk(cuda.cuModuleGetFunction(ctypes.byref(channel_sums_fn), module, b'kweight_window_sums_f64_channel_kernel'), 'cuModuleGetFunction(channel-sums)')
        chk(cuda.cuModuleGetFunction(ctypes.byref(peak_fn), module, b'window_peaks_f64_kernel'), 'cuModuleGetFunction(window-peaks)')
        chk(cuda.cuModuleGetFunction(ctypes.byref(combine_sums_fn), module, b'combine_channel_sums_kernel'), 'cuModuleGetFunction(combine-channel-sums)')
        if cfg.exact_prefix_channel_stats or cfg.exact_safe_feedback_prefix:
            chk(cuda.cuModuleGetFunction(ctypes.byref(prefix_channel_sums_fn), module, b'kweight_window_channel_sums_f64_prefix_kernel'), 'cuModuleGetFunction(prefix-channel-sums)')
    chk(cuda.cuModuleGetFunction(ctypes.byref(gain_fn), module, b'source_port_gain_kernel'), 'cuModuleGetFunction(gain)')
    has_metrics_kernel = cuda.cuModuleGetFunction(ctypes.byref(metrics_fn), module, b'source_port_metrics_kernel') == 0
    if cfg.exact_limiter_active:
        apply_kernel_name = b'apply_plan_f64_io_ffmpeg_feedback_limiter_stream_kernel'
    elif cfg.parallel_final_apply:
        apply_kernel_name = b'apply_plan_f64_io_ffmpeg_timing_final_kernel'
    elif cfg.apply_ffmpeg_timing:
        apply_kernel_name = b'apply_plan_f64_io_ffmpeg_timing_kernel'
    elif input_format == 'f64le':
        apply_kernel_name = b'apply_plan_f64_io_kernel'
    else:
        apply_kernel_name = b'apply_plan_f64_kernel' if output_format == 'f64le' else b'apply_plan_kernel'
    chk(cuda.cuModuleGetFunction(ctypes.byref(apply_fn), module, apply_kernel_name), f'cuModuleGetFunction({apply_kernel_name.decode()})')
    if cfg.exact_prefill_output:
        chk(cuda.cuModuleGetFunction(ctypes.byref(prefill_apply_fn), module, b'apply_plan_f64_io_ffmpeg_timing_final_window_kernel'), 'cuModuleGetFunction(apply_plan_f64_io_ffmpeg_timing_final_window_kernel)')
    if cfg.exact_segmented_safe_feedback:
        chk(cuda.cuModuleGetFunction(ctypes.byref(safe_feedback_energy_fn), module, b'safe_feedback_channel_energy_f64_kernel'), 'cuModuleGetFunction(safe_feedback_channel_energy_f64_kernel)')
        chk(cuda.cuModuleGetFunction(ctypes.byref(safe_feedback_window_fn), module, b'safe_feedback_window_sums_f64_kernel'), 'cuModuleGetFunction(safe_feedback_window_sums_f64_kernel)')
        chk(cuda.cuModuleGetFunction(ctypes.byref(safe_feedback_stitch_fn), module, b'safe_feedback_stitch_f64_kernel'), 'cuModuleGetFunction(safe_feedback_stitch_f64_kernel)')
        chk(cuda.cuModuleGetFunction(ctypes.byref(safe_feedback_fill_fn), module, b'safe_feedback_fill_prefilled_exact_f64_kernel'), 'cuModuleGetFunction(safe_feedback_fill_prefilled_exact_f64_kernel)')
        chk(cuda.cuModuleGetFunction(ctypes.byref(safe_feedback_apply_fn), module, b'safe_feedback_apply6_f64_kernel'), 'cuModuleGetFunction(safe_feedback_apply6_f64_kernel)')
    return SimpleNamespace(**locals())
