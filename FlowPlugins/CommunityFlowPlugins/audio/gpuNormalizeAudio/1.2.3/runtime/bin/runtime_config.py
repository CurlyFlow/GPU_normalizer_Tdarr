from __future__ import annotations

import argparse
import os
from dataclasses import dataclass

from runtime_config_sections import (
    derive_chunk_sizing_config,
    derive_exact_feature_config,
    derive_input_shape,
    derive_limiter_window_config,
    derive_loudnorm_mode,
    derive_source_precompute_config,
)


RUNTIME_BIN = os.path.dirname(os.path.abspath(__file__))
RUNTIME_ROOT = os.path.dirname(RUNTIME_BIN)
PLUGIN_ROOT = os.path.dirname(RUNTIME_ROOT)
RUNTIME_CUDA = os.path.join(RUNTIME_ROOT, 'cuda')

RUNTIME_CONFIG_FIELDS = (
    'input_sample_bytes',
    'streaming_io',
    'stats_cache_only',
    'decode_command',
    'encode_command',
    'frames_per_window',
    'mib',
    'nbytes',
    'paired_stats_active',
    'paired_stats_combined_decode_command',
    'seconds',
    'total_frames',
    'total_samples',
    'windows',
    'apply_ffmpeg_timing',
    'effective_tp',
    'exact_limiter_active',
    'exact_limiter_max_bytes',
    'exact_limiter_requested',
    'force_linear_mode',
    'has_measured',
    'limiter_bypass_safe',
    'linear_f64_io',
    'linear_mode',
    'measured_values',
    'parallel_final_apply',
    'runtime_offset_db',
    'source_faithful_stereo',
    'source_exact_precompute',
    'source_precompute_from_channel_sums',
    'source_channel_hist4_exact',
    'source_channel_hist4_boundary',
    'source_channel_short_exact',
    'source_channel_short_boundary',
    'source_channel_short_margin_lu',
    'source_channel_short_halo_windows',
    'source_channel_hist4_margin_lu',
    'source_channel_hist4_margin_ratio',
    'source_precompute_in_stats',
    'source_sum_audit',
    'source_block_sums',
    'source_block_sum_candidate',
    'source_precompute_device_energy',
    'source_precompute_device_input',
    'source_stage_direct_h2d',
    'source_stage_fixed_buffer',
    'cache_input_lean_source',
    'cache_input_setup_slim',
    'stats_cache_header_sizing',
    'stats_cache_only_slim',
    'source_block_frames',
    'exact_stats_stream',
    'emit_first_pass_json',
    'audit_ffmpeg_input_metrics',
    'exact_prefix_channel_stats',
    'exact_stats_parallel_peaks',
    'exact_stats_fast_launch',
    'stats_prefetch_direct_h2d',
    'stats_prefetch_bytearray_direct_h2d',
    'exact_stats_async_pipeline',
    'source_precompute_fast_launch',
    'source_energy_packed',
    'source_energy_coeff_hoist',
    'source_energy_packed_block_x',
    'source_exact_split_sums',
    'source_exact_split_unroll4',
    'source_exact_split_pointer_walk',
    'source_exact_split_readonly_loads',
    'source_exact_sums_block_x',
    'exact_profile_counts',
    'source_segmented_safe_feedback',
    'exact_prefill_output',
    'defer_safe_risk_gate_copy',
    'exact_safe_feedback_prefix_requested',
    'exact_use_prefilled_output',
    'exact_sparse_chunks',
    'exact_skip_safe_fill',
    'exact_segmented_safe_feedback',
    'exact_skip_safe_feedback',
    'exact_force_safe_idle',
    'exact_safe_feedback_prefix',
    'exact_safe_feedback_prefix_energy',
    'exact_safe_feedback_slot_accum',
    'exact_safe_feedback_window_accum',
    'exact_parallel_unsafe_feedback',
    'exact_skip_unsafe_feedback',
    'exact_unsafe_skip_kernel_6ch',
    'exact_parallel_skip_safe_feedback',
    'exact_safe_run_scan_apply_6ch',
    'exact_apply_fast_launch',
    'gain_metrics_fast_launch',
    'exact_apply_arg_reuse',
    'exact_stream_stage_device',
    'source_parallel_skip_before_threshold',
    'source_unsafe_skip_kernel',
    'source_skip_limiter_lookahead_scan',
    'source_fused_direct_feedback',
    'source_safe_run_scan_apply',
    'ceiling',
    'apply_ceiling',
    'limiter_lookahead_frames',
    'limiter_alloc_frames',
    'final_flush_frames',
    'audit_input_tail_frames',
    'audit_input_replay_frames',
    'exact_skip_safe_fill_margin_frames',
    'exact_risk_expand_windows',
    'exact_risk_expand_before_windows',
    'exact_risk_expand_after_windows',
    'exact_risk_ceiling_scale',
    'exact_use_risk_map',
    'risk_run_cache',
    'chunk_bytes',
    'frame_bytes',
    'audit_input_tail_bytes',
    'window_bytes',
    'exact_unsafe_chunk_bytes',
    'exact_safe_chunk_bytes',
    'stats_chunk_windows',
    'stats_chunk_bytes',
    'exact_channel_stats_combined_peaks',
    'source_precompute_windows',
    'source_precompute_chunk_bytes',
    'source_precompute_stage_bytes',
    'source_block_sum_bytes',
    'source_energy_stage_needed',
    'source_stage_needed',
    'apply_input_chunk_bytes',
    'exact_apply_input_chunk_bytes',
    'output_sample_bytes',
    'output_chunk_bytes',
)


@dataclass(frozen=True)
class RuntimeConfigSections:
    input_shape: object
    loudnorm_mode: object
    source: object
    exact: object
    limiter: object
    sizing: object


class RuntimeConfig:
    def __init__(self, *, sections, values):
        self.sections = sections
        missing = [field for field in RUNTIME_CONFIG_FIELDS if field not in values]
        if missing:
            raise RuntimeError('runtime config missing fields: ' + ', '.join(missing))
        for field in RUNTIME_CONFIG_FIELDS:
            setattr(self, field, values[field])


def parse_runtime_args(argv=None):
    parser = argparse.ArgumentParser(description='CUDA loudness/gain planner and renderer for raw PCM')
    parser.add_argument('input_f32')
    parser.add_argument('output_f32')
    parser.add_argument('--rate', type=int, default=192000)
    parser.add_argument('--channels', type=int, default=2)
    parser.add_argument('--target-i', type=float, default=-18.0)
    parser.add_argument('--target-lra', type=float, default=7.0)
    parser.add_argument('--target-tp', type=float, default=-2.0)
    parser.add_argument('--codec-headroom-db', type=float, default=0.0)
    parser.add_argument('--max-gain-db', type=float, default=15.0)
    parser.add_argument('--dynamic-strength', type=float, default=1.0)
    parser.add_argument('--chunk-mib', type=float, default=1.0)
    parser.add_argument('--measured-i', type=float)
    parser.add_argument('--measured-lra', type=float)
    parser.add_argument('--measured-tp', type=float)
    parser.add_argument('--measured-thresh', type=float)
    parser.add_argument('--offset-db', type=float)
    parser.add_argument('--ffmpeg-linear', action='store_true')
    parser.add_argument('--disable-short-source-exact', action='store_true')
    parser.add_argument('--ffmpeg-limiter', action='store_true')
    parser.add_argument('--ffmpeg-limiter-max-mib', type=float, default=1536.0)
    parser.add_argument('--ffmpeg-gain-offset-ms', type=float, default=210.0)
    parser.add_argument('--input-format', choices=('f32le', 'f64le'), default='f32le')
    parser.add_argument('--output-format', choices=('f32le', 'f64le'), default='f32le')
    parser.add_argument('--ptx-path', default=os.path.join(RUNTIME_CUDA, 'loudnorm_source_port_kernels.ptx'))
    parser.add_argument('--source-core-path', default=os.path.join(RUNTIME_BIN, 'loudnorm-source-cpu'))
    parser.add_argument('--dump-window-gains')
    parser.add_argument('--dump-window-gains-next')
    parser.add_argument('--streaming-io', action='store_true', help='Read the input path twice as a sequential stream and write output as a sequential stream. Used with FIFOs to avoid raw PCM files.')
    parser.add_argument('--expected-seconds', type=float, default=0.0, help='Upper-bound duration estimate for streaming allocation/progress.')
    parser.add_argument('--decode-command-json', help='JSON argv for one FFmpeg decode pass writing raw PCM to stdout.')
    parser.add_argument('--encode-command-json', help='JSON argv for FFmpeg encode reading raw PCM from stdin.')
    parser.add_argument('--stats-cache-output', help='Write stats pass device state to this cache file.')
    parser.add_argument('--stats-cache-input', help='Load stats pass device state from this cache file and skip stats decode.')
    parser.add_argument('--stats-cache-only', action='store_true', help='Run only stats decode/cache output, then exit.')
    parser.add_argument('--paired-stats-decode-command-json', help='JSON argv for a second raw PCM stats stream consumed in the same CUDA runtime.')
    parser.add_argument('--paired-stats-combined-decode-command-json', help='JSON argv for one raw PCM stats stream containing primary channels followed by paired channels.')
    parser.add_argument('--paired-stats-combined-channels', type=int, default=0)
    parser.add_argument('--paired-stats-cache-output', help='Write paired stats cache for the second stream.')
    parser.add_argument('--paired-stats-channels', type=int, default=0)
    parser.add_argument('--paired-stats-rate', type=int, default=0)
    parser.add_argument('--paired-stats-stereo-fallback-source-exact', action='store_true')
    parser.add_argument('--paired-apply-decode-command-json', help='JSON argv for a second raw PCM apply stream consumed in the same CUDA runtime.')
    parser.add_argument('--paired-apply-encode-command-json', help='JSON argv for FFmpeg encode reading the paired raw PCM output from stdin.')
    parser.add_argument('--paired-apply-stats-cache-input', help='Load paired apply stats pass device state from this cache file.')
    parser.add_argument('--paired-apply-channels', type=int, default=0)
    parser.add_argument('--paired-apply-rate', type=int, default=0)
    parser.add_argument('--paired-apply-chunk-mib', type=float, default=0.0)
    parser.add_argument('--paired-apply-measured-i', type=float)
    parser.add_argument('--paired-apply-measured-lra', type=float)
    parser.add_argument('--paired-apply-measured-tp', type=float)
    parser.add_argument('--paired-apply-measured-thresh', type=float)
    parser.add_argument('--paired-apply-offset-db', type=float)
    parser.add_argument('--paired-apply-stereo-fallback-source-exact', action='store_true')
    parser.add_argument('--emit-first-pass-json', action='store_true', help='Emit loudnorm-style first-pass JSON from the GPU exact dynamic pass.')
    parser.add_argument('--parallel-final-apply', action='store_true', help='Experimental: use parallel f64 apply with FFmpeg final-flush timing after exact source-port gain planning.')
    parser.add_argument('--stereo-fallback-source-exact', action='store_true', help='Use the source-faithful generated-stereo fallback path instead of shared optimized feedback shortcuts.')
    return parser.parse_args(argv)


def derive_runtime_config(args):
    if args.input_format == 'f64le' and args.output_format != 'f64le':
        raise SystemExit('f64le input currently requires f64le output')
    input_sample_bytes = 8 if args.input_format == 'f64le' else 4
    streaming_io = bool(args.streaming_io)
    stats_cache_only = bool(args.stats_cache_only)

    input_shape = derive_input_shape(args, input_sample_bytes=input_sample_bytes, streaming_io=streaming_io, stats_cache_only=stats_cache_only)
    loudnorm_mode = derive_loudnorm_mode(args, stats_cache_only=stats_cache_only)

    source_config = derive_source_precompute_config(
        args,
        exact_limiter_requested=loudnorm_mode.exact_limiter_requested,
        frames_per_window=input_shape.frames_per_window,
        stats_cache_only=stats_cache_only,
    )
    exact_config = derive_exact_feature_config(
        args,
        exact_limiter_active=loudnorm_mode.exact_limiter_active,
        source_config=source_config,
    )
    limiter_config = derive_limiter_window_config(
        args,
        frames_per_window=input_shape.frames_per_window,
        effective_tp=loudnorm_mode.effective_tp,
        linear_mode=loudnorm_mode.linear_mode,
        exact_limiter_active=loudnorm_mode.exact_limiter_active,
        exact_skip_safe_fill=exact_config.exact_skip_safe_fill,
        source_faithful_stereo=source_config.source_faithful_stereo,
        source_segmented_safe_feedback=exact_config.source_segmented_safe_feedback,
    )
    sizing_config = derive_chunk_sizing_config(
        args,
        input_sample_bytes=input_sample_bytes,
        nbytes=input_shape.nbytes,
        frames_per_window=input_shape.frames_per_window,
        exact_limiter_active=loudnorm_mode.exact_limiter_active,
        source_config=source_config,
        limiter_config=limiter_config,
    )

    config_values = {
        'input_sample_bytes': input_sample_bytes,
        'streaming_io': streaming_io,
        'stats_cache_only': stats_cache_only,
    }
    for section in (input_shape, loudnorm_mode, source_config, exact_config, limiter_config, sizing_config):
        config_values.update(vars(section))
    return RuntimeConfig(
        sections=RuntimeConfigSections(
            input_shape=input_shape,
            loudnorm_mode=loudnorm_mode,
            source=source_config,
            exact=exact_config,
            limiter=limiter_config,
            sizing=sizing_config,
        ),
        values=config_values,
    )


def apply_stats_result_to_config(cfg, stats_result):
    cfg.nbytes = stats_result.nbytes
    cfg.mib = stats_result.mib
    cfg.total_samples = stats_result.total_samples
    cfg.total_frames = stats_result.total_frames
    cfg.windows = stats_result.windows
    cfg.seconds = stats_result.seconds
