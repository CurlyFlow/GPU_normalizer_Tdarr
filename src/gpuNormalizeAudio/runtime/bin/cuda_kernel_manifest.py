from __future__ import annotations

import ctypes
from dataclasses import dataclass
from types import SimpleNamespace

from source_exact_modes import source_exact_load_variants


@dataclass(frozen=True)
class KernelLoadSpec:
    attr: str
    symbol: str
    label: str
    required: bool = True


@dataclass(frozen=True)
class KernelLoadPlan:
    specs: tuple[KernelLoadSpec, ...]
    input_format: str
    output_format: str
    apply_kernel_name: str | None


KERNEL_HANDLE_ATTRS = (
    'short_filter_fn',
    'short_gain_fn',
    'short_apply_fn',
    'q_fn',
    'q_no_peaks_fn',
    'sums_fn',
    'exact_sums_fn',
    'channel_sums_fn',
    'channel_sums_unroll4_fn',
    'channel_checkpoint_states_fn',
    'channel_sums_warp_fn',
    'channel_sums_no_peaks_fn',
    'channel_sums_source_energy_fn',
    'paired_channel_sums_fn',
    'peak_fn',
    'channel_sums_offset_fn',
    'peak_offset_fn',
    'compact_offset_fn',
    'prefix_channel_sums_fn',
    'prefix_channel_sums_unroll4_fn',
    'prefix_start_states_fn',
    'output_prefix_start_states_fn',
    'output_prefix_start_states_shared_fn',
    'source_exact_sums_fn',
    'source_exact_split_sums_fn',
    'source_exact_split_unroll4_sums_fn',
    'source_exact_split_pointer_sums_fn',
    'source_exact_split_readonly_sums_fn',
    'source_exact_from_channel_sums_fn',
    'source_exact_hist4_sums_fn',
    'source_exact_short_sums_fn',
    'source_selective_short_sums_fn',
    'source_mark_short_raw_corrections_fn',
    'source_apply_short_raw_corrections_fn',
    'source_selective_hist4_sums_fn',
    'source_energy_fn',
    'source_energy_packed_fn',
    'source_energy_packed_hoist_fn',
    'source_block_sums_fn',
    'source_block_prefix_sums_fn',
    'source_block_exact_sums_fn',
    'combine_sums_fn',
    'gain_fn',
    'metrics_fn',
    'apply_fn',
    'prefill_apply_fn',
    'safe_feedback_energy_fn',
    'safe_feedback_window_fn',
    'safe_feedback_stitch_fn',
    'safe_feedback_fill_fn',
    'safe_feedback_apply_fn',
    'safe_feedback_skip_apply_fn',
)


CUDA_KERNEL_SYMBOLS = (
    'short_source_filter_f64_kernel',
    'short_source_gain_f64_kernel',
    'short_source_apply_f64_kernel',
    'apply_linear_f64_io_kernel',
    'apply_plan_f64_io_ffmpeg_feedback_limiter_stream_kernel',
    'apply_plan_f64_io_ffmpeg_timing_final_kernel',
    'apply_plan_f64_io_ffmpeg_timing_final_window_kernel',
    'apply_plan_f64_io_ffmpeg_timing_kernel',
    'apply_plan_f64_io_kernel',
    'apply_plan_f64_kernel',
    'apply_plan_kernel',
    'combine_channel_sums_kernel',
    'compact_f64_channels_offset_kernel',
    'convert_f64_to_f32_kernel',
    'kweight_build_start_states_f64_kernel',
    'kweight_build_start_states_range_f64_kernel',
    'kweight_build_start_states_range_shared_f64_kernel',
    'kweight_window_channel_sums_f64_prefix_kernel',
    'kweight_window_channel_sums_f64_prefix_unroll4_kernel',
    'kweight_window_q_f64_kernel',
    'kweight_window_q_f64_no_peaks_kernel',
    'kweight_window_q_kernel',
    'kweight_window_sums_f64_paired_combined_kernel',
    'kweight_window_checkpoint_states_f64_channel_kernel',
    'kweight_window_sums_f64_channel_kernel',
    'kweight_window_sums_f64_channel_unroll4_kernel',
    'kweight_window_sums_f64_channel_warp_kernel',
    'kweight_window_sums_f64_channel_no_peaks_kernel',
    'kweight_window_sums_f64_channel_offset_kernel',
    'kweight_window_sums_f64_channel_source_energy_kernel',
    'kweight_window_sums_f64_kernel',
    'kweight_window_sums_f64_stream_kernel',
    'kweight_window_sums_kernel',
    'safe_feedback_apply6_f64_kernel',
    'safe_feedback_channel_energy_f64_kernel',
    'safe_feedback_fill_prefilled_exact_f64_kernel',
    'safe_feedback_skip_apply6_f64_kernel',
    'safe_feedback_stitch_f64_kernel',
    'safe_feedback_window_sums_f64_kernel',
    'source_port_gain_kernel',
    'source_port_metrics_kernel',
    'source_stereo_block_exact_sums_f64_kernel',
    'source_stereo_block_prefix_sums_f64_kernel',
    'source_stereo_block_sums_f64_kernel',
    'source_stereo_energy_f64_kernel',
    'source_stereo_energy_packed_f64_kernel',
    'source_stereo_energy_packed_hoist_f64_kernel',
    'source_stereo_exact_hist4_sums_f64_kernel',
    'source_stereo_exact_short_sums_f64_kernel',
    'source_stereo_exact_sums_f64_kernel',
    'source_stereo_exact_sums_from_channel_sums_f64_kernel',
    'source_stereo_exact_sums_split_f64_kernel',
    'source_stereo_exact_sums_split_pointer_f64_kernel',
    'source_stereo_exact_sums_split_readonly_f64_kernel',
    'source_stereo_exact_sums_split_unroll4_f64_kernel',
    'source_stereo_apply_short_raw_corrections_f64_kernel',
    'source_stereo_mark_short_raw_corrections_f64_kernel',
    'source_stereo_selective_hist4_sums_f64_kernel',
    'source_stereo_selective_short_sums_f64_kernel',
    'window_peaks_f64_kernel',
    'window_peaks_f64_offset_kernel',
)


def _spec(attr, symbol, label=None, *, required=True):
    return KernelLoadSpec(attr, symbol, label or symbol, required)


def _apply_kernel_symbol(args, cfg):
    if getattr(cfg.loudnorm_mode, 'linear_f64_io', False):
        return 'apply_linear_f64_io_kernel'
    if cfg.loudnorm_mode.exact_limiter_active:
        return 'apply_plan_f64_io_ffmpeg_feedback_limiter_stream_kernel'
    if cfg.loudnorm_mode.parallel_final_apply:
        return 'apply_plan_f64_io_ffmpeg_timing_final_kernel'
    if cfg.loudnorm_mode.apply_ffmpeg_timing:
        return 'apply_plan_f64_io_ffmpeg_timing_kernel'
    if args.input_format == 'f64le':
        return 'apply_plan_f64_io_kernel'
    return 'apply_plan_f64_kernel' if args.output_format == 'f64le' else 'apply_plan_kernel'


def resolve_kernel_load_plan(args, cfg):
    input_format = args.input_format
    output_format = args.output_format
    q_kernel_name = 'kweight_window_q_f64_kernel' if input_format == 'f64le' else 'kweight_window_q_kernel'
    sums_kernel_name = 'kweight_window_sums_f64_kernel' if input_format == 'f64le' else 'kweight_window_sums_kernel'
    specs = [
        _spec('q_fn', q_kernel_name),
        _spec('sums_fn', sums_kernel_name),
    ]
    if input_format == 'f64le' and output_format == 'f64le':
        specs.extend([
            _spec('short_filter_fn', 'short_source_filter_f64_kernel'),
            _spec('short_gain_fn', 'short_source_gain_f64_kernel'),
            _spec('short_apply_fn', 'short_source_apply_f64_kernel'),
        ])
    if cfg.exact.exact_stats_stream or cfg.exact.audit_ffmpeg_input_metrics or cfg.exact.emit_first_pass_json:
        specs.append(_spec('exact_sums_fn', 'kweight_window_sums_f64_stream_kernel', 'exact-sums'))
    if cfg.loudnorm_mode.exact_limiter_active and input_format == 'f64le' and not cfg.exact.exact_stats_stream:
        specs.extend([
            _spec('channel_sums_fn', 'kweight_window_sums_f64_channel_kernel', 'channel-sums'),
            *([_spec('channel_sums_unroll4_fn', 'kweight_window_sums_f64_channel_unroll4_kernel', 'channel-sums-unroll4')] if getattr(cfg.exact, 'exact_channel_stats_unroll4', False) else []),
            *([_spec('channel_checkpoint_states_fn', 'kweight_window_checkpoint_states_f64_channel_kernel', 'channel-checkpoint-states')] if (getattr(cfg.exact, 'exact_channel_stats_checkpoint_replay', False) or getattr(cfg.exact, 'emit_first_pass_json', False)) else []),
            *([_spec('channel_sums_warp_fn', 'kweight_window_sums_f64_channel_warp_kernel', 'channel-sums-warp')] if getattr(cfg.exact, 'exact_channel_stats_warp', False) else []),
            *([_spec('channel_sums_no_peaks_fn', 'kweight_window_sums_f64_channel_no_peaks_kernel', 'channel-sums-no-peaks')] if getattr(cfg.exact, 'exact_channel_stats_no_peaks', False) else []),
            *([_spec('channel_sums_source_energy_fn', 'kweight_window_sums_f64_channel_source_energy_kernel', 'channel-sums-source-energy')] if cfg.source.source_precompute_device_energy else []),
            *([_spec('paired_channel_sums_fn', 'kweight_window_sums_f64_paired_combined_kernel', 'paired-channel-sums')] if getattr(cfg.exact, 'exact_paired_stats_fused_kernel', False) else []),
            _spec('peak_fn', 'window_peaks_f64_kernel', 'window-peaks'),
            _spec('channel_sums_offset_fn', 'kweight_window_sums_f64_channel_offset_kernel', 'channel-sums-offset'),
            _spec('peak_offset_fn', 'window_peaks_f64_offset_kernel', 'window-peaks-offset'),
            _spec('compact_offset_fn', 'compact_f64_channels_offset_kernel', 'compact-f64-channels-offset'),
            _spec('combine_sums_fn', 'combine_channel_sums_kernel', 'combine-channel-sums'),
        ])
        if cfg.source.source_exact_precompute:
            specs.extend(_spec(variant.attr, variant.symbol, variant.label) for variant in source_exact_load_variants(cfg))
            if cfg.source.source_precompute_from_channel_sums:
                specs.append(_spec('source_exact_from_channel_sums_fn', 'source_stereo_exact_sums_from_channel_sums_f64_kernel', 'source-stereo-exact-sums-from-channel-sums'))
                if cfg.source.source_channel_hist4_exact or cfg.source.source_channel_hist4_boundary or cfg.source.source_channel_short_exact or cfg.source.source_channel_short_boundary or getattr(cfg.source, 'source_channel_short_raw_boundary', False):
                    if cfg.source.source_channel_hist4_exact or cfg.source.source_channel_short_exact or cfg.source.source_channel_short_boundary:
                        specs.append(_spec('source_energy_fn', 'source_stereo_energy_f64_kernel', 'source-stereo-energy'))
                    if cfg.source.source_channel_hist4_exact:
                        specs.append(_spec('source_exact_hist4_sums_fn', 'source_stereo_exact_hist4_sums_f64_kernel', 'source-stereo-exact-hist4-sums'))
                    if cfg.source.source_channel_short_exact:
                        specs.append(_spec('source_exact_short_sums_fn', 'source_stereo_exact_short_sums_f64_kernel', 'source-stereo-exact-short-sums'))
                    if cfg.source.source_channel_short_boundary:
                        specs.append(_spec('source_selective_short_sums_fn', 'source_stereo_selective_short_sums_f64_kernel', 'source-stereo-selective-short-sums'))
                    if getattr(cfg.source, 'source_channel_short_raw_boundary', False):
                        specs.extend([
                            _spec('source_mark_short_raw_corrections_fn', 'source_stereo_mark_short_raw_corrections_f64_kernel', 'source-stereo-mark-short-raw-corrections'),
                            _spec('source_apply_short_raw_corrections_fn', 'source_stereo_apply_short_raw_corrections_f64_kernel', 'source-stereo-apply-short-raw-corrections'),
                        ])
                    if cfg.source.source_channel_hist4_boundary:
                        specs.append(_spec('source_selective_hist4_sums_fn', 'source_stereo_selective_hist4_sums_f64_kernel', 'source-stereo-selective-hist4-sums'))
            else:
                specs.append(_spec('source_energy_fn', 'source_stereo_energy_f64_kernel', 'source-stereo-energy'))
                if getattr(cfg.exact, 'source_energy_packed', False):
                    specs.append(_spec('source_energy_packed_fn', 'source_stereo_energy_packed_f64_kernel', 'source-stereo-energy-packed'))
                    if getattr(cfg.exact, 'source_energy_coeff_hoist', False):
                        specs.append(_spec('source_energy_packed_hoist_fn', 'source_stereo_energy_packed_hoist_f64_kernel', 'source-stereo-energy-packed-hoist'))
                if cfg.source.source_block_sum_candidate:
                    specs.extend([
                        _spec('source_block_sums_fn', 'source_stereo_block_sums_f64_kernel', 'source-stereo-block-sums'),
                        _spec('source_block_prefix_sums_fn', 'source_stereo_block_prefix_sums_f64_kernel', 'source-stereo-block-prefix-sums'),
                        _spec('source_block_exact_sums_fn', 'source_stereo_block_exact_sums_f64_kernel', 'source-stereo-block-exact-sums'),
                    ])
        if cfg.exact.exact_prefix_channel_stats or cfg.exact.exact_safe_feedback_prefix or getattr(cfg.exact, 'exact_channel_stats_checkpoint_replay', False):
            specs.extend([
                _spec('prefix_channel_sums_fn', 'kweight_window_channel_sums_f64_prefix_kernel', 'prefix-channel-sums'),
                _spec('prefix_start_states_fn', 'kweight_build_start_states_f64_kernel', 'prefix-start-states'),
            ])
        if cfg.exact.emit_first_pass_json:
            if not (cfg.exact.exact_prefix_channel_stats or cfg.exact.exact_safe_feedback_prefix or getattr(cfg.exact, 'exact_channel_stats_checkpoint_replay', False)):
                specs.append(_spec('prefix_channel_sums_fn', 'kweight_window_channel_sums_f64_prefix_kernel', 'prefix-channel-sums'))
            specs.append(_spec('prefix_channel_sums_unroll4_fn', 'kweight_window_channel_sums_f64_prefix_unroll4_kernel', 'prefix-channel-sums-unroll4'))
            specs.append(_spec('output_prefix_start_states_fn', 'kweight_build_start_states_range_f64_kernel', 'output-prefix-start-states'))
            specs.append(_spec('output_prefix_start_states_shared_fn', 'kweight_build_start_states_range_shared_f64_kernel', 'output-prefix-start-states-shared'))
            if input_format == 'f64le':
                specs.append(_spec('q_no_peaks_fn', 'kweight_window_q_f64_no_peaks_kernel', 'q-no-peaks'))
    apply_kernel_name = _apply_kernel_symbol(args, cfg)
    specs.extend([
        _spec('gain_fn', 'source_port_gain_kernel', 'gain'),
        _spec('metrics_fn', 'source_port_metrics_kernel', 'source-port-metrics', required=False),
        _spec('apply_fn', apply_kernel_name),
    ])
    if cfg.exact.exact_prefill_output:
        specs.append(_spec('prefill_apply_fn', 'apply_plan_f64_io_ffmpeg_timing_final_window_kernel'))
    if cfg.exact.exact_segmented_safe_feedback:
        specs.extend([
            _spec('safe_feedback_energy_fn', 'safe_feedback_channel_energy_f64_kernel'),
            _spec('safe_feedback_window_fn', 'safe_feedback_window_sums_f64_kernel'),
            _spec('safe_feedback_stitch_fn', 'safe_feedback_stitch_f64_kernel'),
            _spec('safe_feedback_fill_fn', 'safe_feedback_fill_prefilled_exact_f64_kernel'),
            _spec('safe_feedback_apply_fn', 'safe_feedback_apply6_f64_kernel'),
        ])
        if cfg.exact.exact_parallel_skip_safe_feedback:
            specs.append(_spec('safe_feedback_skip_apply_fn', 'safe_feedback_skip_apply6_f64_kernel'))

    return KernelLoadPlan(tuple(specs), input_format, output_format, apply_kernel_name)


def load_cuda_kernel_set(cuda, module, args, cfg, check):
    plan = resolve_kernel_load_plan(args, cfg)
    handles = {attr: ctypes.c_void_p() for attr in KERNEL_HANDLE_ATTRS}
    has_metrics_kernel = False
    for spec in plan.specs:
        handle = handles[spec.attr]
        rc = cuda.cuModuleGetFunction(ctypes.byref(handle), module, spec.symbol.encode())
        if spec.required:
            check(rc, f'cuModuleGetFunction({spec.label})')
        elif spec.attr == 'metrics_fn':
            has_metrics_kernel = rc == 0
    return SimpleNamespace(
        **handles,
        apply_kernel_name=plan.apply_kernel_name.encode() if plan.apply_kernel_name else None,
        has_metrics_kernel=has_metrics_kernel,
        input_format=plan.input_format,
        output_format=plan.output_format,
    )
