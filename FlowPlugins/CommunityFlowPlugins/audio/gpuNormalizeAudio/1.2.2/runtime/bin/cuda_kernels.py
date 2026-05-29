from __future__ import annotations

import ctypes
from types import SimpleNamespace

from cuda_driver import chk


def load_kernel_set(cuda, module, args, cfg):
    q_fn = ctypes.c_void_p()
    sums_fn = ctypes.c_void_p()
    exact_sums_fn = ctypes.c_void_p()
    channel_sums_fn = ctypes.c_void_p()
    channel_sums_source_energy_fn = ctypes.c_void_p()
    peak_fn = ctypes.c_void_p()
    channel_sums_offset_fn = ctypes.c_void_p()
    peak_offset_fn = ctypes.c_void_p()
    compact_offset_fn = ctypes.c_void_p()
    prefix_channel_sums_fn = ctypes.c_void_p()
    prefix_start_states_fn = ctypes.c_void_p()
    source_exact_sums_fn = ctypes.c_void_p()
    source_exact_split_sums_fn = ctypes.c_void_p()
    source_exact_split_unroll4_sums_fn = ctypes.c_void_p()
    source_exact_split_pointer_sums_fn = ctypes.c_void_p()
    source_exact_split_readonly_sums_fn = ctypes.c_void_p()
    source_exact_from_channel_sums_fn = ctypes.c_void_p()
    source_exact_hist4_sums_fn = ctypes.c_void_p()
    source_exact_short_sums_fn = ctypes.c_void_p()
    source_selective_short_sums_fn = ctypes.c_void_p()
    source_selective_hist4_sums_fn = ctypes.c_void_p()
    source_energy_fn = ctypes.c_void_p()
    source_energy_packed_fn = ctypes.c_void_p()
    source_energy_packed_hoist_fn = ctypes.c_void_p()
    source_block_sums_fn = ctypes.c_void_p()
    source_block_prefix_sums_fn = ctypes.c_void_p()
    source_block_exact_sums_fn = ctypes.c_void_p()
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
    safe_feedback_skip_apply_fn = ctypes.c_void_p()
    input_format = args.input_format
    output_format = args.output_format
    cache_input_setup_slim = getattr(cfg, 'cache_input_setup_slim', False) and not (
        cfg.audit_ffmpeg_input_metrics
        or cfg.emit_first_pass_json
        or cfg.exact_prefix_channel_stats
        or cfg.exact_safe_feedback_prefix
    )
    q_kernel_name = b'kweight_window_q_f64_kernel' if input_format == 'f64le' else b'kweight_window_q_kernel'
    sums_kernel_name = b'kweight_window_sums_f64_kernel' if input_format == 'f64le' else b'kweight_window_sums_kernel'
    chk(cuda.cuModuleGetFunction(ctypes.byref(q_fn), module, q_kernel_name), f'cuModuleGetFunction({q_kernel_name.decode()})')
    chk(cuda.cuModuleGetFunction(ctypes.byref(sums_fn), module, sums_kernel_name), f'cuModuleGetFunction({sums_kernel_name.decode()})')
    if cfg.exact_stats_stream or cfg.audit_ffmpeg_input_metrics or cfg.emit_first_pass_json:
        chk(cuda.cuModuleGetFunction(ctypes.byref(exact_sums_fn), module, b'kweight_window_sums_f64_stream_kernel'), 'cuModuleGetFunction(exact-sums)')
    if cfg.exact_limiter_active and input_format == 'f64le' and not cfg.exact_stats_stream and not cache_input_setup_slim:
        chk(cuda.cuModuleGetFunction(ctypes.byref(channel_sums_fn), module, b'kweight_window_sums_f64_channel_kernel'), 'cuModuleGetFunction(channel-sums)')
        if cfg.source_precompute_device_energy:
            chk(cuda.cuModuleGetFunction(ctypes.byref(channel_sums_source_energy_fn), module, b'kweight_window_sums_f64_channel_source_energy_kernel'), 'cuModuleGetFunction(channel-sums-source-energy)')
        chk(cuda.cuModuleGetFunction(ctypes.byref(peak_fn), module, b'window_peaks_f64_kernel'), 'cuModuleGetFunction(window-peaks)')
        chk(cuda.cuModuleGetFunction(ctypes.byref(channel_sums_offset_fn), module, b'kweight_window_sums_f64_channel_offset_kernel'), 'cuModuleGetFunction(channel-sums-offset)')
        chk(cuda.cuModuleGetFunction(ctypes.byref(peak_offset_fn), module, b'window_peaks_f64_offset_kernel'), 'cuModuleGetFunction(window-peaks-offset)')
        chk(cuda.cuModuleGetFunction(ctypes.byref(compact_offset_fn), module, b'compact_f64_channels_offset_kernel'), 'cuModuleGetFunction(compact-f64-channels-offset)')
        chk(cuda.cuModuleGetFunction(ctypes.byref(combine_sums_fn), module, b'combine_channel_sums_kernel'), 'cuModuleGetFunction(combine-channel-sums)')
        if cfg.source_exact_precompute and not getattr(cfg, 'cache_input_lean_source', False):
            chk(cuda.cuModuleGetFunction(ctypes.byref(source_exact_sums_fn), module, b'source_stereo_exact_sums_f64_kernel'), 'cuModuleGetFunction(source-stereo-exact-sums)')
            if getattr(cfg, 'source_exact_split_sums', False):
                chk(cuda.cuModuleGetFunction(ctypes.byref(source_exact_split_sums_fn), module, b'source_stereo_exact_sums_split_f64_kernel'), 'cuModuleGetFunction(source-stereo-exact-sums-split)')
                if getattr(cfg, 'source_exact_split_unroll4', False):
                    chk(cuda.cuModuleGetFunction(ctypes.byref(source_exact_split_unroll4_sums_fn), module, b'source_stereo_exact_sums_split_unroll4_f64_kernel'), 'cuModuleGetFunction(source-stereo-exact-sums-split-unroll4)')
                if getattr(cfg, 'source_exact_split_pointer_walk', False):
                    chk(cuda.cuModuleGetFunction(ctypes.byref(source_exact_split_pointer_sums_fn), module, b'source_stereo_exact_sums_split_pointer_f64_kernel'), 'cuModuleGetFunction(source-stereo-exact-sums-split-pointer)')
                if getattr(cfg, 'source_exact_split_readonly_loads', False):
                    chk(cuda.cuModuleGetFunction(ctypes.byref(source_exact_split_readonly_sums_fn), module, b'source_stereo_exact_sums_split_readonly_f64_kernel'), 'cuModuleGetFunction(source-stereo-exact-sums-split-readonly)')
            if cfg.source_precompute_from_channel_sums:
                chk(cuda.cuModuleGetFunction(ctypes.byref(source_exact_from_channel_sums_fn), module, b'source_stereo_exact_sums_from_channel_sums_f64_kernel'), 'cuModuleGetFunction(source-stereo-exact-sums-from-channel-sums)')
                if cfg.source_channel_hist4_exact or cfg.source_channel_hist4_boundary or cfg.source_channel_short_exact or cfg.source_channel_short_boundary:
                    if cfg.source_channel_hist4_exact or cfg.source_channel_short_exact or cfg.source_channel_short_boundary:
                        chk(cuda.cuModuleGetFunction(ctypes.byref(source_energy_fn), module, b'source_stereo_energy_f64_kernel'), 'cuModuleGetFunction(source-stereo-energy)')
                    if cfg.source_channel_hist4_exact:
                        chk(cuda.cuModuleGetFunction(ctypes.byref(source_exact_hist4_sums_fn), module, b'source_stereo_exact_hist4_sums_f64_kernel'), 'cuModuleGetFunction(source-stereo-exact-hist4-sums)')
                    if cfg.source_channel_short_exact:
                        chk(cuda.cuModuleGetFunction(ctypes.byref(source_exact_short_sums_fn), module, b'source_stereo_exact_short_sums_f64_kernel'), 'cuModuleGetFunction(source-stereo-exact-short-sums)')
                    if cfg.source_channel_short_boundary:
                        chk(cuda.cuModuleGetFunction(ctypes.byref(source_selective_short_sums_fn), module, b'source_stereo_selective_short_sums_f64_kernel'), 'cuModuleGetFunction(source-stereo-selective-short-sums)')
                    if cfg.source_channel_hist4_boundary:
                        chk(cuda.cuModuleGetFunction(ctypes.byref(source_selective_hist4_sums_fn), module, b'source_stereo_selective_hist4_sums_f64_kernel'), 'cuModuleGetFunction(source-stereo-selective-hist4-sums)')
            else:
                chk(cuda.cuModuleGetFunction(ctypes.byref(source_energy_fn), module, b'source_stereo_energy_f64_kernel'), 'cuModuleGetFunction(source-stereo-energy)')
                if getattr(cfg, 'source_energy_packed', False):
                    chk(cuda.cuModuleGetFunction(ctypes.byref(source_energy_packed_fn), module, b'source_stereo_energy_packed_f64_kernel'), 'cuModuleGetFunction(source-stereo-energy-packed)')
                    if getattr(cfg, 'source_energy_coeff_hoist', False):
                        chk(cuda.cuModuleGetFunction(ctypes.byref(source_energy_packed_hoist_fn), module, b'source_stereo_energy_packed_hoist_f64_kernel'), 'cuModuleGetFunction(source-stereo-energy-packed-hoist)')
                if cfg.source_block_sum_candidate:
                    chk(cuda.cuModuleGetFunction(ctypes.byref(source_block_sums_fn), module, b'source_stereo_block_sums_f64_kernel'), 'cuModuleGetFunction(source-stereo-block-sums)')
                    chk(cuda.cuModuleGetFunction(ctypes.byref(source_block_prefix_sums_fn), module, b'source_stereo_block_prefix_sums_f64_kernel'), 'cuModuleGetFunction(source-stereo-block-prefix-sums)')
                    chk(cuda.cuModuleGetFunction(ctypes.byref(source_block_exact_sums_fn), module, b'source_stereo_block_exact_sums_f64_kernel'), 'cuModuleGetFunction(source-stereo-block-exact-sums)')
        if cfg.exact_prefix_channel_stats or cfg.exact_safe_feedback_prefix:
            chk(cuda.cuModuleGetFunction(ctypes.byref(prefix_channel_sums_fn), module, b'kweight_window_channel_sums_f64_prefix_kernel'), 'cuModuleGetFunction(prefix-channel-sums)')
            chk(cuda.cuModuleGetFunction(ctypes.byref(prefix_start_states_fn), module, b'kweight_build_start_states_f64_kernel'), 'cuModuleGetFunction(prefix-start-states)')
    has_metrics_kernel = False
    if not getattr(cfg, 'stats_cache_only_slim', False):
        chk(cuda.cuModuleGetFunction(ctypes.byref(gain_fn), module, b'source_port_gain_kernel'), 'cuModuleGetFunction(gain)')
        has_metrics_kernel = cuda.cuModuleGetFunction(ctypes.byref(metrics_fn), module, b'source_port_metrics_kernel') == 0
        if getattr(cfg, 'linear_f64_io', False):
            apply_kernel_name = b'apply_linear_f64_io_kernel'
        elif cfg.exact_limiter_active:
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
            if cfg.exact_parallel_skip_safe_feedback:
                chk(cuda.cuModuleGetFunction(ctypes.byref(safe_feedback_skip_apply_fn), module, b'safe_feedback_skip_apply6_f64_kernel'), 'cuModuleGetFunction(safe_feedback_skip_apply6_f64_kernel)')
    return SimpleNamespace(**locals())
