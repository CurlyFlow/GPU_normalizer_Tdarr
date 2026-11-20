from __future__ import annotations

from dataclasses import dataclass

from runtime_env import env_flag, env_int, env_nonnegative_int


@dataclass(frozen=True)
class ExactFeatureConfig:
    exact_stats_stream: bool
    emit_first_pass_json: bool
    audit_ffmpeg_input_metrics: bool
    exact_prefix_channel_stats: bool
    exact_stats_parallel_peaks: bool
    exact_stats_async_parallel_peaks: bool
    exact_channel_stats_warp: bool
    exact_channel_stats_no_peaks: bool
    exact_channel_stats_unroll4: bool
    exact_channel_stats_cpu_native: bool
    exact_channel_stats_checkpoint_replay: bool
    exact_paired_stats_fused_kernel: bool
    exact_stats_fast_launch: bool
    stats_prefetch_direct_h2d: bool
    stats_prefetch_bytearray_direct_h2d: bool
    stats_prefetch_pinned_async_h2d: bool
    stats_prefetch_pinned_async_buffers: int
    exact_stats_async_pipeline: bool
    exact_stats_async_pinned_pipeline: bool
    source_precompute_fast_launch: bool
    source_energy_packed: bool
    source_energy_coeff_hoist: bool
    source_energy_packed_block_x: int
    source_exact_split_sums: bool
    source_exact_split_unroll4: bool
    source_exact_split_pointer_walk: bool
    source_exact_split_readonly_loads: bool
    source_exact_sums_block_x: int
    exact_profile_counts: bool
    audit_ffmpeg_state_snapshots: bool
    audit_ffmpeg_state_sample_windows: int
    audit_ffmpeg_state_max_events: int
    audit_ffmpeg_state_force_direct: bool
    source_segmented_safe_feedback: bool
    exact_prefill_output: bool
    defer_safe_risk_gate_copy: bool
    exact_safe_feedback_prefix_requested: bool
    exact_use_prefilled_output: bool
    exact_sparse_chunks: bool
    exact_skip_safe_fill: bool
    exact_segmented_safe_feedback: bool
    exact_skip_safe_feedback: bool
    exact_force_safe_idle: bool
    exact_safe_feedback_prefix: bool
    exact_safe_feedback_prefix_energy: bool
    exact_safe_feedback_slot_accum: bool
    exact_safe_feedback_window_accum: bool
    exact_parallel_unsafe_feedback: bool
    exact_skip_unsafe_feedback: bool
    exact_unsafe_skip_kernel_6ch: bool
    exact_parallel_skip_safe_feedback: bool
    exact_safe_skip_apply_frame_kernel: bool
    exact_skip_apply_rolling_ring_6ch: bool
    exact_safe_skip_6ch_single_wrap: bool
    exact_safe_run_scan_apply_6ch: bool
    exact_safe_run_scan_apply_6ch_boundary_halo_windows: int
    exact_apply_fast_launch: bool
    gain_metrics_fast_launch: bool
    gain_plan_cpu_native: bool
    paired_gain_plan_concurrent: bool
    exact_apply_arg_reuse: bool
    source_parallel_skip_before_threshold: bool
    source_unsafe_skip_kernel: bool
    source_skip_limiter_lookahead_scan: bool
    source_fused_direct_feedback: bool
    source_safe_run_scan_apply: bool


def _exact_f64(args, exact_limiter_active):
    return exact_limiter_active and args.input_format == 'f64le'


def _clamp_source_energy_block_x(value):
    return 32 if value <= 32 else 64 if value <= 64 else 128


def _clamp_source_sums_block_x(value):
    return 64 if value <= 64 else 128


def _derive_stats_features(args, *, exact_limiter_active, source_config):
    source_exact_precompute = source_config.source_exact_precompute
    f64_exact = _exact_f64(args, exact_limiter_active)
    exact_channel_stats_cpu_native = f64_exact and env_flag('LOUDNORM_GPU_CHANNEL_STATS_CPU_NATIVE', True)
    exact_stats_fast_launch = f64_exact and env_flag('LOUDNORM_GPU_STATS_FAST_LAUNCH', True)
    return {
        'exact_stats_stream': exact_limiter_active and (not source_exact_precompute) and env_flag('LOUDNORM_GPU_EXACT_STATS_STREAM'),
        'exact_prefix_channel_stats': f64_exact and (not source_exact_precompute) and env_flag('LOUDNORM_GPU_PREFIX_CHANNEL_STATS'),
        'exact_stats_parallel_peaks': f64_exact and env_flag('LOUDNORM_GPU_STATS_PARALLEL_PEAKS'),
        'exact_stats_async_parallel_peaks': f64_exact and env_flag('LOUDNORM_GPU_STATS_ASYNC_PARALLEL_PEAKS'),
        'exact_channel_stats_warp': f64_exact and env_flag('LOUDNORM_GPU_CHANNEL_STATS_WARP'),
        'exact_channel_stats_no_peaks': f64_exact and env_flag('LOUDNORM_GPU_CHANNEL_STATS_NO_PEAKS'),
        'exact_channel_stats_unroll4': f64_exact and env_flag('LOUDNORM_GPU_CHANNEL_STATS_UNROLL4'),
        'exact_channel_stats_cpu_native': exact_channel_stats_cpu_native,
        'exact_channel_stats_checkpoint_replay': f64_exact and env_flag('LOUDNORM_GPU_CHANNEL_STATS_CHECKPOINT_REPLAY'),
        'exact_paired_stats_fused_kernel': f64_exact and env_flag('LOUDNORM_GPU_PAIR_FALLBACK_STATS_FUSED_KERNEL'),
        'exact_stats_fast_launch': exact_stats_fast_launch,
        'stats_prefetch_direct_h2d': f64_exact and env_flag('LOUDNORM_GPU_STATS_PREFETCH_DIRECT_H2D'),
        'stats_prefetch_bytearray_direct_h2d': f64_exact and env_flag('LOUDNORM_GPU_STATS_PREFETCH_BYTEARRAY_DIRECT_H2D'),
        'stats_prefetch_pinned_async_h2d': f64_exact and env_flag('LOUDNORM_GPU_STATS_PREFETCH_PINNED_ASYNC_H2D'),
        'stats_prefetch_pinned_async_buffers': env_int('LOUDNORM_GPU_STATS_PREFETCH_PINNED_ASYNC_BUFFERS', 2, minimum=2),
        'exact_stats_async_pipeline': exact_stats_fast_launch and not exact_channel_stats_cpu_native and not source_config.source_precompute_device_input and env_flag('LOUDNORM_GPU_STATS_ASYNC_PIPELINE'),
        'exact_stats_async_pinned_pipeline': exact_stats_fast_launch and not exact_channel_stats_cpu_native and not source_config.source_precompute_device_input and env_flag('LOUDNORM_GPU_STATS_ASYNC_PINNED_PIPELINE'),
    }


def _derive_source_kernel_features(*, source_config, stats_features):
    source_exact_precompute = source_config.source_exact_precompute
    source_precompute_from_channel_sums = source_config.source_precompute_from_channel_sums
    source_energy_packed = source_exact_precompute and (not source_precompute_from_channel_sums) and env_flag('LOUDNORM_GPU_STEREO_SOURCE_ENERGY_PACKED', True)
    source_exact_split_sums = source_exact_precompute and (not source_precompute_from_channel_sums) and env_flag('LOUDNORM_GPU_STEREO_SOURCE_EXACT_SPLIT_SUMS', True)
    return {
        'source_precompute_fast_launch': source_exact_precompute and stats_features['exact_stats_fast_launch'] and env_flag('LOUDNORM_GPU_STEREO_SOURCE_PRECOMPUTE_FAST_LAUNCH'),
        'source_energy_packed': source_energy_packed,
        'source_energy_coeff_hoist': source_energy_packed and env_flag('LOUDNORM_GPU_STEREO_SOURCE_ENERGY_COEFF_HOIST'),
        'source_energy_packed_block_x': _clamp_source_energy_block_x(env_int('LOUDNORM_GPU_STEREO_SOURCE_ENERGY_PACKED_BLOCK_X', 32, minimum=1)),
        'source_exact_split_sums': source_exact_split_sums,
        'source_exact_split_unroll4': source_exact_split_sums and env_flag('LOUDNORM_GPU_STEREO_SOURCE_EXACT_SPLIT_UNROLL4'),
        'source_exact_split_pointer_walk': source_exact_split_sums and source_energy_packed and env_flag('LOUDNORM_GPU_STEREO_SOURCE_EXACT_SPLIT_POINTER_WALK'),
        'source_exact_split_readonly_loads': source_exact_split_sums and source_energy_packed and env_flag('LOUDNORM_GPU_STEREO_SOURCE_EXACT_SPLIT_READONLY_LOADS'),
        'source_exact_sums_block_x': _clamp_source_sums_block_x(env_int('LOUDNORM_GPU_STEREO_SOURCE_EXACT_SUMS_BLOCK_X', 128, minimum=1)),
    }


def _derive_audit_features(args, *, exact_limiter_active):
    audit_ffmpeg_state_snapshots = exact_limiter_active and args.input_format == 'f64le' and args.output_format == 'f64le' and env_flag('LOUDNORM_GPU_AUDIT_FFMPEG_STATE')
    return {
        'emit_first_pass_json': _exact_f64(args, exact_limiter_active) and bool(args.emit_first_pass_json or args.emit_first_pass_input_json),
        'audit_ffmpeg_input_metrics': _exact_f64(args, exact_limiter_active) and env_flag('LOUDNORM_GPU_AUDIT_FFMPEG_INPUT_METRICS'),
        'exact_profile_counts': exact_limiter_active and env_flag('LOUDNORM_GPU_PROFILE_EXACT_COUNTS'),
        'audit_ffmpeg_state_snapshots': audit_ffmpeg_state_snapshots,
        'audit_ffmpeg_state_sample_windows': env_int('LOUDNORM_GPU_AUDIT_FFMPEG_STATE_SAMPLE_WINDOWS', 1, minimum=1),
        'audit_ffmpeg_state_max_events': env_nonnegative_int('LOUDNORM_GPU_AUDIT_FFMPEG_STATE_MAX_EVENTS', 0),
        'audit_ffmpeg_state_force_direct': audit_ffmpeg_state_snapshots and env_flag('LOUDNORM_GPU_AUDIT_FFMPEG_STATE_FORCE_DIRECT', True),
    }


def _derive_feedback_features(args, *, exact_limiter_active, source_config, audit_features):
    source_exact_precompute = source_config.source_exact_precompute
    source_faithful_stereo = source_config.source_faithful_stereo
    source_segmented_safe_feedback = source_exact_precompute and env_flag('LOUDNORM_GPU_STEREO_SOURCE_SEGMENTED_SAFE', True)
    exact_prefill_output = exact_limiter_active and not audit_features['audit_ffmpeg_state_force_direct'] and ((not source_faithful_stereo) or source_segmented_safe_feedback) and env_flag('LOUDNORM_GPU_PREFILL_EXACT_OUTPUT', True)
    exact_use_prefilled_output = exact_prefill_output and env_flag('LOUDNORM_GPU_USE_PREFILLED_OUTPUT')
    exact_sparse_chunks = exact_limiter_active and exact_prefill_output and env_flag('LOUDNORM_GPU_SPARSE_CHUNKS', True)
    exact_skip_safe_fill = exact_use_prefilled_output and exact_sparse_chunks and env_flag('LOUDNORM_GPU_SKIP_SAFE_FILL', True)
    exact_segmented_safe_feedback = exact_limiter_active and exact_prefill_output and ((not source_faithful_stereo) or source_segmented_safe_feedback) and env_flag('LOUDNORM_GPU_SEGMENTED_SAFE_FEEDBACK', True)
    exact_skip_safe_feedback = exact_segmented_safe_feedback and env_flag('LOUDNORM_GPU_SKIP_SAFE_FEEDBACK', True)
    exact_safe_feedback_prefix_requested = env_flag('LOUDNORM_GPU_SAFE_FEEDBACK_PREFIX')
    exact_safe_feedback_prefix = exact_segmented_safe_feedback and exact_skip_safe_fill and exact_safe_feedback_prefix_requested
    exact_safe_feedback_slot_accum = exact_segmented_safe_feedback and env_flag('LOUDNORM_GPU_SAFE_FEEDBACK_SLOT_ACCUM', True)
    exact_parallel_unsafe_feedback = exact_safe_feedback_slot_accum and ((not source_faithful_stereo) or source_segmented_safe_feedback) and env_flag('LOUDNORM_GPU_PARALLEL_UNSAFE_FEEDBACK', True)
    exact_parallel_skip_safe_feedback = exact_skip_safe_feedback and env_flag('LOUDNORM_GPU_PARALLEL_SKIP_SAFE_FEEDBACK', True)
    return {
        'source_segmented_safe_feedback': source_segmented_safe_feedback,
        'exact_prefill_output': exact_prefill_output,
        'defer_safe_risk_gate_copy': exact_prefill_output and env_flag('LOUDNORM_GPU_DEFER_SAFE_RISK_GATE_COPY'),
        'exact_safe_feedback_prefix_requested': exact_safe_feedback_prefix_requested,
        'exact_use_prefilled_output': exact_use_prefilled_output,
        'exact_sparse_chunks': exact_sparse_chunks,
        'exact_skip_safe_fill': exact_skip_safe_fill,
        'exact_segmented_safe_feedback': exact_segmented_safe_feedback,
        'exact_skip_safe_feedback': exact_skip_safe_feedback,
        'exact_force_safe_idle': exact_skip_safe_feedback and env_flag('LOUDNORM_GPU_FORCE_SAFE_IDLE'),
        'exact_safe_feedback_prefix': exact_safe_feedback_prefix,
        'exact_safe_feedback_prefix_energy': exact_safe_feedback_prefix and env_flag('LOUDNORM_GPU_SAFE_FEEDBACK_PREFIX_ENERGY'),
        'exact_safe_feedback_slot_accum': exact_safe_feedback_slot_accum,
        'exact_safe_feedback_window_accum': exact_segmented_safe_feedback and not exact_safe_feedback_slot_accum and env_flag('LOUDNORM_GPU_SAFE_FEEDBACK_WINDOW_ACCUM'),
        'exact_parallel_unsafe_feedback': exact_parallel_unsafe_feedback,
        'exact_skip_unsafe_feedback': exact_parallel_unsafe_feedback and exact_skip_safe_feedback and env_flag('LOUDNORM_GPU_SKIP_UNSAFE_FEEDBACK', True),
        'exact_unsafe_skip_kernel_6ch': exact_parallel_unsafe_feedback and env_flag('LOUDNORM_GPU_UNSAFE_SKIP_KERNEL_6CH'),
        'exact_parallel_skip_safe_feedback': exact_parallel_skip_safe_feedback,
        'exact_safe_skip_apply_frame_kernel': exact_parallel_skip_safe_feedback and env_flag('LOUDNORM_GPU_SAFE_SKIP_APPLY_FRAME_KERNEL'),
        'exact_skip_apply_rolling_ring_6ch': exact_parallel_skip_safe_feedback and args.channels == 6 and env_flag('LOUDNORM_GPU_SKIP_APPLY_ROLLING_RING_6CH'),
        'exact_safe_skip_6ch_single_wrap': exact_parallel_skip_safe_feedback and args.channels == 6 and env_flag('LOUDNORM_GPU_SAFE_SKIP_6CH_SINGLE_WRAP'),
        'exact_safe_run_scan_apply_6ch': exact_parallel_skip_safe_feedback and env_flag('LOUDNORM_GPU_SAFE_RUN_SCAN_APPLY_6CH'),
        'exact_safe_run_scan_apply_6ch_boundary_halo_windows': env_nonnegative_int('LOUDNORM_GPU_SAFE_RUN_SCAN_APPLY_6CH_BOUNDARY_HALO_WINDOWS', 0),
    }


def _derive_apply_features(args, *, exact_limiter_active, source_config, feedback_features):
    source_exact_precompute = source_config.source_exact_precompute
    return {
        'exact_apply_fast_launch': exact_limiter_active and env_flag('LOUDNORM_GPU_APPLY_FAST_LAUNCH'),
        'gain_metrics_fast_launch': exact_limiter_active and env_flag('LOUDNORM_GPU_GAIN_METRICS_FAST_LAUNCH'),
        'gain_plan_cpu_native': _exact_f64(args, exact_limiter_active) and env_flag('LOUDNORM_GPU_GAIN_PLAN_CPU_NATIVE'),
        'paired_gain_plan_concurrent': _exact_f64(args, exact_limiter_active) and env_flag('LOUDNORM_GPU_PAIRED_GAIN_PLAN_CONCURRENT'),
        'exact_apply_arg_reuse': exact_limiter_active and env_flag('LOUDNORM_GPU_APPLY_ARG_REUSE'),
        'source_parallel_skip_before_threshold': source_exact_precompute and feedback_features['exact_parallel_skip_safe_feedback'] and env_flag('LOUDNORM_GPU_STEREO_SOURCE_PARALLEL_SKIP_BEFORE_THRESHOLD', True),
        'source_unsafe_skip_kernel': source_exact_precompute and feedback_features['exact_parallel_unsafe_feedback'] and env_flag('LOUDNORM_GPU_STEREO_SOURCE_UNSAFE_SKIP_KERNEL', True),
        'source_skip_limiter_lookahead_scan': source_exact_precompute and args.channels == 2 and env_flag('LOUDNORM_GPU_STEREO_SOURCE_SKIP_LIMITER_LOOKAHEAD_SCAN'),
        'source_fused_direct_feedback': source_exact_precompute and args.channels == 2 and env_flag('LOUDNORM_GPU_STEREO_SOURCE_FUSED_DIRECT_FEEDBACK'),
        'source_safe_run_scan_apply': source_exact_precompute and env_flag('LOUDNORM_GPU_SAFE_RUN_SCAN_APPLY'),
    }


def derive_exact_feature_config(args, *, exact_limiter_active, source_config):
    stats_features = _derive_stats_features(args, exact_limiter_active=exact_limiter_active, source_config=source_config)
    source_features = _derive_source_kernel_features(source_config=source_config, stats_features=stats_features)
    audit_features = _derive_audit_features(args, exact_limiter_active=exact_limiter_active)
    feedback_features = _derive_feedback_features(args, exact_limiter_active=exact_limiter_active, source_config=source_config, audit_features=audit_features)
    apply_features = _derive_apply_features(args, exact_limiter_active=exact_limiter_active, source_config=source_config, feedback_features=feedback_features)
    return ExactFeatureConfig(
        **stats_features,
        **source_features,
        **audit_features,
        **feedback_features,
        **apply_features,
    )
