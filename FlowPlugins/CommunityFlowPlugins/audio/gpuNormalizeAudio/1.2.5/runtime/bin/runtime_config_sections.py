from __future__ import annotations

import json
import math
import os
from types import SimpleNamespace

from loudnorm_math import db_to_amp, frame_size
from runtime_env import env_flag


def _load_command_json(value, label):
    command = json.loads(value)
    if not (isinstance(command, list) and command and all(isinstance(v, str) for v in command)):
        raise SystemExit(f'{label} must be a JSON string array')
    return command


def derive_input_shape(args, *, input_sample_bytes, streaming_io, stats_cache_only):
    paired_stats_active = bool(args.paired_stats_decode_command_json or args.paired_stats_combined_decode_command_json or args.paired_stats_cache_output or args.paired_stats_channels)
    if args.stats_cache_only and not args.stats_cache_output:
        raise SystemExit('--stats-cache-only requires --stats-cache-output')
    if args.stats_cache_input and args.stats_cache_output:
        raise SystemExit('--stats-cache-input and --stats-cache-output are mutually exclusive')
    if paired_stats_active:
        if not stats_cache_only:
            raise SystemExit('--paired-stats-* requires --stats-cache-only')
        if not args.paired_stats_decode_command_json or not args.paired_stats_cache_output or args.paired_stats_channels <= 0:
            raise SystemExit('--paired-stats-decode-command-json, --paired-stats-cache-output, and --paired-stats-channels are required together')
        if args.paired_stats_combined_decode_command_json and args.paired_stats_combined_channels < args.channels + args.paired_stats_channels:
            raise SystemExit('--paired-stats-combined-channels must include primary and paired channels')
    if streaming_io and args.input_format != 'f64le':
        raise SystemExit('--streaming-io currently requires f64le input')

    decode_command = None
    encode_command = None
    if streaming_io:
        if not args.decode_command_json or (not stats_cache_only and not args.encode_command_json):
            raise SystemExit('--streaming-io requires --decode-command-json and --encode-command-json')
        decode_command = _load_command_json(args.decode_command_json, '--decode-command-json')
        encode_command = None if stats_cache_only else _load_command_json(args.encode_command_json, '--encode-command-json')

    paired_stats_combined_decode_command = None
    if args.paired_stats_combined_decode_command_json:
        paired_stats_combined_decode_command = _load_command_json(args.paired_stats_combined_decode_command_json, '--paired-stats-combined-decode-command-json')

    if streaming_io:
        if not (args.expected_seconds > 0.0 and math.isfinite(args.expected_seconds)):
            raise SystemExit('--streaming-io requires --expected-seconds')
        estimated_seconds = max(args.expected_seconds + 60.0, args.expected_seconds * 1.25)
        nbytes = int(math.ceil(estimated_seconds * args.rate * args.channels * input_sample_bytes))
        frame_align = args.channels * input_sample_bytes
        nbytes += (-nbytes) % frame_align
    else:
        nbytes = os.path.getsize(args.input_f32)
    if nbytes <= 0 or nbytes % input_sample_bytes:
        raise SystemExit(f'input size must be positive multiple of {args.input_format}')
    total_samples = nbytes // input_sample_bytes
    if total_samples % args.channels:
        raise SystemExit('input sample count must be divisible by channels')
    total_frames = total_samples // args.channels
    frames_per_window = max(1, int((args.rate + 5) // 10))
    windows = (total_frames + frames_per_window - 1) // frames_per_window
    seconds = total_frames / float(args.rate)
    mib = nbytes / (1024 * 1024)
    return SimpleNamespace(
        decode_command=decode_command,
        encode_command=encode_command,
        frames_per_window=frames_per_window,
        mib=mib,
        nbytes=nbytes,
        paired_stats_active=paired_stats_active,
        paired_stats_combined_decode_command=paired_stats_combined_decode_command,
        seconds=seconds,
        total_frames=total_frames,
        total_samples=total_samples,
        windows=windows,
    )


def derive_loudnorm_mode(args, *, stats_cache_only):
    measured_values = [args.measured_i, args.measured_lra, args.measured_tp, args.measured_thresh]
    has_measured = all(value is not None and math.isfinite(value) for value in measured_values)
    runtime_offset_db = args.offset_db if args.offset_db is not None and math.isfinite(args.offset_db) else 0.0
    linear_mode = False
    force_linear_mode = env_flag('LOUDNORM_GPU_FORCE_LINEAR_MODE')
    if args.ffmpeg_linear and has_measured and (force_linear_mode or env_flag('LOUDNORM_GPU_ALLOW_LINEAR_MODE', True)):
        linear_offset = args.target_i - args.measured_i
        offset_tp = args.measured_tp + linear_offset
        if force_linear_mode or (
            args.measured_tp != 99.0
            and args.measured_thresh != -70.0
            and args.measured_lra != 0.0
            and args.measured_i != 0.0
            and offset_tp <= args.target_tp
            and args.measured_lra <= args.target_lra
        ):
            linear_mode = True
            runtime_offset_db = linear_offset
    exact_limiter_requested = args.ffmpeg_limiter and args.input_format == 'f64le' and args.output_format == 'f64le' and (has_measured or stats_cache_only) and not linear_mode
    exact_limiter_max_bytes = int(max(0.0, args.ffmpeg_limiter_max_mib) * 1024 * 1024)
    effective_tp = args.target_tp - max(0.0, args.codec_headroom_db)
    limiter_bypass_safe = has_measured and ((args.measured_tp if args.measured_tp is not None else 0.0) + runtime_offset_db) <= (effective_tp + 1e-9)
    parallel_final_apply = exact_limiter_requested and args.parallel_final_apply and limiter_bypass_safe and env_flag('LOUDNORM_GPU_ALLOW_PARALLEL_FINAL_APPLY')
    exact_limiter_active = exact_limiter_requested and not parallel_final_apply
    apply_ffmpeg_timing = args.input_format == 'f64le' and has_measured and not linear_mode
    linear_f64_io = linear_mode and args.input_format == 'f64le' and args.output_format == 'f64le'
    return SimpleNamespace(
        apply_ffmpeg_timing=apply_ffmpeg_timing,
        effective_tp=effective_tp,
        exact_limiter_active=exact_limiter_active,
        exact_limiter_max_bytes=exact_limiter_max_bytes,
        exact_limiter_requested=exact_limiter_requested,
        force_linear_mode=force_linear_mode,
        has_measured=has_measured,
        limiter_bypass_safe=limiter_bypass_safe,
        linear_f64_io=linear_f64_io,
        linear_mode=linear_mode,
        measured_values=measured_values,
        parallel_final_apply=parallel_final_apply,
        runtime_offset_db=runtime_offset_db,
    )


def derive_source_precompute_config(args, *, exact_limiter_requested, frames_per_window, stats_cache_only):
    if args.stereo_fallback_source_exact and args.channels != 2:
        raise SystemExit('--stereo-fallback-source-exact requires --channels 2')
    source_faithful_stereo = exact_limiter_requested and args.stereo_fallback_source_exact and args.channels == 2
    source_exact_precompute = source_faithful_stereo and env_flag('LOUDNORM_GPU_STEREO_SOURCE_PRECOMPUTE', True)
    source_precompute_from_channel_sums = source_exact_precompute and env_flag('LOUDNORM_GPU_STEREO_SOURCE_PRECOMPUTE_FROM_CHANNEL_SUMS')
    source_channel_hist4_exact = source_precompute_from_channel_sums and env_flag('LOUDNORM_GPU_STEREO_SOURCE_CHANNEL_HIST4_EXACT')
    source_channel_hist4_boundary = source_precompute_from_channel_sums and (not source_channel_hist4_exact) and env_flag('LOUDNORM_GPU_STEREO_SOURCE_CHANNEL_HIST4_BOUNDARY')
    source_channel_short_exact = source_precompute_from_channel_sums and env_flag('LOUDNORM_GPU_STEREO_SOURCE_CHANNEL_SHORT_EXACT')
    source_channel_short_boundary = source_precompute_from_channel_sums and (not source_channel_short_exact) and env_flag('LOUDNORM_GPU_STEREO_SOURCE_CHANNEL_SHORT_BOUNDARY')
    source_channel_short_raw_boundary = source_precompute_from_channel_sums and (not source_channel_short_exact) and (not source_channel_short_boundary) and env_flag('LOUDNORM_GPU_STEREO_SOURCE_CHANNEL_SHORT_RAW_BOUNDARY')
    try:
        source_channel_short_margin_lu = max(0.0, float(os.environ.get('LOUDNORM_GPU_STEREO_SOURCE_CHANNEL_SHORT_MARGIN_LU', '0.001')))
    except ValueError:
        source_channel_short_margin_lu = 0.001
    try:
        source_channel_short_halo_windows = max(0, int(os.environ.get('LOUDNORM_GPU_STEREO_SOURCE_CHANNEL_SHORT_HALO_WINDOWS', '30')))
    except ValueError:
        source_channel_short_halo_windows = 30
    try:
        source_channel_hist4_margin_lu = max(0.0, float(os.environ.get('LOUDNORM_GPU_STEREO_SOURCE_CHANNEL_HIST4_MARGIN_LU', '0.005')))
    except ValueError:
        source_channel_hist4_margin_lu = 0.005
    source_channel_hist4_margin_ratio = 10.0 ** (source_channel_hist4_margin_lu / 10.0)
    source_precompute_in_stats = source_exact_precompute and (not source_precompute_from_channel_sums) and env_flag('LOUDNORM_GPU_STEREO_SOURCE_PRECOMPUTE_IN_STATS', True)
    source_sum_audit = source_exact_precompute and (not source_precompute_from_channel_sums) and env_flag('LOUDNORM_GPU_STEREO_SOURCE_SUM_AUDIT')
    source_block_sums = source_exact_precompute and (not source_precompute_from_channel_sums) and env_flag('LOUDNORM_GPU_STEREO_SOURCE_BLOCK_SUMS')
    source_block_sum_candidate = source_exact_precompute and (not source_precompute_from_channel_sums) and (source_sum_audit or source_block_sums)
    source_precompute_device_energy = source_precompute_in_stats and args.channels == 2 and not source_sum_audit and not source_block_sum_candidate and env_flag('LOUDNORM_GPU_STEREO_SOURCE_PRECOMPUTE_DEVICE_ENERGY', False)
    source_precompute_device_input = source_precompute_in_stats and args.channels == 2 and not source_precompute_device_energy and not source_sum_audit and not source_block_sum_candidate and env_flag('LOUDNORM_GPU_STEREO_SOURCE_PRECOMPUTE_DEVICE_INPUT', False)
    source_stage_direct_h2d = source_exact_precompute and (not source_precompute_device_energy) and (not source_precompute_device_input) and env_flag('LOUDNORM_GPU_SOURCE_STAGE_DIRECT_H2D')
    source_stage_fixed_buffer = source_precompute_in_stats and (not source_precompute_device_energy) and (not source_precompute_device_input) and env_flag('LOUDNORM_GPU_SOURCE_STAGE_FIXED_BUFFER')
    cache_input_lean_source = bool(args.stats_cache_input) and source_exact_precompute and env_flag('LOUDNORM_GPU_CACHE_INPUT_LEAN_SOURCE')
    cache_input_setup_slim = bool(args.stats_cache_input) and env_flag('LOUDNORM_GPU_CACHE_INPUT_SETUP_SLIM')
    stats_cache_header_sizing = bool(args.stats_cache_input) and env_flag('LOUDNORM_GPU_STATS_CACHE_HEADER_SIZING')
    stats_cache_only_slim = stats_cache_only and env_flag('LOUDNORM_GPU_STATS_CACHE_ONLY_SLIM')
    try:
        source_block_frames = max(1, int(os.environ.get('LOUDNORM_GPU_STEREO_SOURCE_BLOCK_FRAMES', '64')))
    except ValueError:
        source_block_frames = 64
    source_block_frames = min(source_block_frames, frames_per_window)
    try:
        source_block_exact_after_window = int(os.environ.get('LOUDNORM_GPU_STEREO_SOURCE_BLOCK_EXACT_AFTER_WINDOW', '-1'))
    except ValueError:
        source_block_exact_after_window = -1
    try:
        source_block_exact_until_window = int(os.environ.get('LOUDNORM_GPU_STEREO_SOURCE_BLOCK_EXACT_UNTIL_WINDOW', '-1'))
    except ValueError:
        source_block_exact_until_window = -1
    return SimpleNamespace(
        source_faithful_stereo=source_faithful_stereo,
        source_exact_precompute=source_exact_precompute,
        source_precompute_from_channel_sums=source_precompute_from_channel_sums,
        source_channel_hist4_exact=source_channel_hist4_exact,
        source_channel_hist4_boundary=source_channel_hist4_boundary,
        source_channel_short_exact=source_channel_short_exact,
        source_channel_short_boundary=source_channel_short_boundary,
        source_channel_short_raw_boundary=source_channel_short_raw_boundary,
        source_channel_short_margin_lu=source_channel_short_margin_lu,
        source_channel_short_halo_windows=source_channel_short_halo_windows,
        source_channel_hist4_margin_lu=source_channel_hist4_margin_lu,
        source_channel_hist4_margin_ratio=source_channel_hist4_margin_ratio,
        source_precompute_in_stats=source_precompute_in_stats,
        source_sum_audit=source_sum_audit,
        source_block_sums=source_block_sums,
        source_block_sum_candidate=source_block_sum_candidate,
        source_precompute_device_energy=source_precompute_device_energy,
        source_precompute_device_input=source_precompute_device_input,
        source_stage_direct_h2d=source_stage_direct_h2d,
        source_stage_fixed_buffer=source_stage_fixed_buffer,
        cache_input_lean_source=cache_input_lean_source,
        cache_input_setup_slim=cache_input_setup_slim,
        stats_cache_header_sizing=stats_cache_header_sizing,
        stats_cache_only_slim=stats_cache_only_slim,
        source_block_frames=source_block_frames,
        source_block_exact_after_window=source_block_exact_after_window,
        source_block_exact_until_window=source_block_exact_until_window,
    )


def derive_exact_feature_config(args, *, exact_limiter_active, source_config):
    source_exact_precompute = source_config.source_exact_precompute
    source_faithful_stereo = source_config.source_faithful_stereo
    source_precompute_from_channel_sums = source_config.source_precompute_from_channel_sums
    exact_stats_stream = exact_limiter_active and (not source_exact_precompute) and env_flag('LOUDNORM_GPU_EXACT_STATS_STREAM')
    emit_first_pass_json = exact_limiter_active and args.input_format == 'f64le' and bool(args.emit_first_pass_json)
    audit_ffmpeg_input_metrics = exact_limiter_active and args.input_format == 'f64le' and env_flag('LOUDNORM_GPU_AUDIT_FFMPEG_INPUT_METRICS')
    exact_prefix_channel_stats = exact_limiter_active and args.input_format == 'f64le' and (not source_exact_precompute) and env_flag('LOUDNORM_GPU_PREFIX_CHANNEL_STATS')
    exact_stats_parallel_peaks = exact_limiter_active and args.input_format == 'f64le' and env_flag('LOUDNORM_GPU_STATS_PARALLEL_PEAKS')
    exact_stats_async_parallel_peaks = exact_limiter_active and args.input_format == 'f64le' and env_flag('LOUDNORM_GPU_STATS_ASYNC_PARALLEL_PEAKS')
    exact_channel_stats_warp = exact_limiter_active and args.input_format == 'f64le' and env_flag('LOUDNORM_GPU_CHANNEL_STATS_WARP')
    exact_channel_stats_no_peaks = exact_limiter_active and args.input_format == 'f64le' and env_flag('LOUDNORM_GPU_CHANNEL_STATS_NO_PEAKS')
    exact_channel_stats_unroll4 = exact_limiter_active and args.input_format == 'f64le' and env_flag('LOUDNORM_GPU_CHANNEL_STATS_UNROLL4')
    exact_channel_stats_cpu_native = exact_limiter_active and args.input_format == 'f64le' and env_flag('LOUDNORM_GPU_CHANNEL_STATS_CPU_NATIVE', True)
    exact_channel_stats_checkpoint_replay = exact_limiter_active and args.input_format == 'f64le' and env_flag('LOUDNORM_GPU_CHANNEL_STATS_CHECKPOINT_REPLAY')
    exact_paired_stats_fused_kernel = exact_limiter_active and args.input_format == 'f64le' and env_flag('LOUDNORM_GPU_PAIR_FALLBACK_STATS_FUSED_KERNEL')
    exact_stats_fast_launch = exact_limiter_active and args.input_format == 'f64le' and env_flag('LOUDNORM_GPU_STATS_FAST_LAUNCH', True)
    stats_prefetch_direct_h2d = exact_limiter_active and args.input_format == 'f64le' and env_flag('LOUDNORM_GPU_STATS_PREFETCH_DIRECT_H2D')
    stats_prefetch_bytearray_direct_h2d = exact_limiter_active and args.input_format == 'f64le' and env_flag('LOUDNORM_GPU_STATS_PREFETCH_BYTEARRAY_DIRECT_H2D')
    stats_prefetch_pinned_async_h2d = exact_limiter_active and args.input_format == 'f64le' and env_flag('LOUDNORM_GPU_STATS_PREFETCH_PINNED_ASYNC_H2D')
    try:
        stats_prefetch_pinned_async_buffers = max(2, int(os.environ.get('LOUDNORM_GPU_STATS_PREFETCH_PINNED_ASYNC_BUFFERS', '2')))
    except ValueError:
        stats_prefetch_pinned_async_buffers = 2
    exact_stats_async_pinned_pipeline = exact_stats_fast_launch and not exact_channel_stats_cpu_native and not source_config.source_precompute_device_input and env_flag('LOUDNORM_GPU_STATS_ASYNC_PINNED_PIPELINE')
    exact_stats_async_pipeline = exact_stats_fast_launch and not exact_channel_stats_cpu_native and not source_config.source_precompute_device_input and env_flag('LOUDNORM_GPU_STATS_ASYNC_PIPELINE')
    source_precompute_fast_launch = source_exact_precompute and exact_stats_fast_launch and env_flag('LOUDNORM_GPU_STEREO_SOURCE_PRECOMPUTE_FAST_LAUNCH')
    source_energy_packed = source_exact_precompute and (not source_precompute_from_channel_sums) and env_flag('LOUDNORM_GPU_STEREO_SOURCE_ENERGY_PACKED', True)
    source_energy_coeff_hoist = source_energy_packed and env_flag('LOUDNORM_GPU_STEREO_SOURCE_ENERGY_COEFF_HOIST')
    try:
        source_energy_packed_block_x = int(os.environ.get('LOUDNORM_GPU_STEREO_SOURCE_ENERGY_PACKED_BLOCK_X', '32'))
    except ValueError:
        source_energy_packed_block_x = 32
    source_energy_packed_block_x = 32 if source_energy_packed_block_x <= 32 else 64 if source_energy_packed_block_x <= 64 else 128
    source_exact_split_sums = source_exact_precompute and (not source_precompute_from_channel_sums) and env_flag('LOUDNORM_GPU_STEREO_SOURCE_EXACT_SPLIT_SUMS', True)
    source_exact_split_unroll4 = source_exact_split_sums and env_flag('LOUDNORM_GPU_STEREO_SOURCE_EXACT_SPLIT_UNROLL4')
    source_exact_split_pointer_walk = source_exact_split_sums and source_energy_packed and env_flag('LOUDNORM_GPU_STEREO_SOURCE_EXACT_SPLIT_POINTER_WALK')
    source_exact_split_readonly_loads = source_exact_split_sums and source_energy_packed and env_flag('LOUDNORM_GPU_STEREO_SOURCE_EXACT_SPLIT_READONLY_LOADS')
    try:
        source_exact_sums_block_x = int(os.environ.get('LOUDNORM_GPU_STEREO_SOURCE_EXACT_SUMS_BLOCK_X', '128'))
    except ValueError:
        source_exact_sums_block_x = 128
    source_exact_sums_block_x = 64 if source_exact_sums_block_x <= 64 else 128
    exact_profile_counts = exact_limiter_active and env_flag('LOUDNORM_GPU_PROFILE_EXACT_COUNTS')
    source_segmented_safe_feedback = source_exact_precompute and env_flag('LOUDNORM_GPU_STEREO_SOURCE_SEGMENTED_SAFE', True)
    exact_prefill_output = exact_limiter_active and ((not source_faithful_stereo) or source_segmented_safe_feedback) and env_flag('LOUDNORM_GPU_PREFILL_EXACT_OUTPUT', True)
    defer_safe_risk_gate_copy = exact_prefill_output and env_flag('LOUDNORM_GPU_DEFER_SAFE_RISK_GATE_COPY')
    exact_safe_feedback_prefix_requested = env_flag('LOUDNORM_GPU_SAFE_FEEDBACK_PREFIX')
    exact_use_prefilled_output = exact_prefill_output and env_flag('LOUDNORM_GPU_USE_PREFILLED_OUTPUT')
    exact_sparse_chunks = exact_limiter_active and exact_prefill_output and env_flag('LOUDNORM_GPU_SPARSE_CHUNKS', True)
    exact_skip_safe_fill = exact_use_prefilled_output and exact_sparse_chunks and env_flag('LOUDNORM_GPU_SKIP_SAFE_FILL', True)
    exact_segmented_safe_feedback = exact_limiter_active and exact_prefill_output and ((not source_faithful_stereo) or source_segmented_safe_feedback) and env_flag('LOUDNORM_GPU_SEGMENTED_SAFE_FEEDBACK', True)
    exact_skip_safe_feedback = exact_segmented_safe_feedback and env_flag('LOUDNORM_GPU_SKIP_SAFE_FEEDBACK', True)
    exact_force_safe_idle = exact_skip_safe_feedback and env_flag('LOUDNORM_GPU_FORCE_SAFE_IDLE')
    exact_safe_feedback_prefix = exact_segmented_safe_feedback and exact_skip_safe_fill and exact_safe_feedback_prefix_requested
    exact_safe_feedback_prefix_energy = exact_safe_feedback_prefix and env_flag('LOUDNORM_GPU_SAFE_FEEDBACK_PREFIX_ENERGY')
    exact_safe_feedback_prefix_post_fill = exact_safe_feedback_prefix_energy and env_flag('LOUDNORM_GPU_SAFE_FEEDBACK_PREFIX_POST_FILL')
    exact_safe_feedback_slot_accum = exact_segmented_safe_feedback and env_flag('LOUDNORM_GPU_SAFE_FEEDBACK_SLOT_ACCUM', True)
    exact_safe_feedback_window_accum = exact_segmented_safe_feedback and not exact_safe_feedback_slot_accum and env_flag('LOUDNORM_GPU_SAFE_FEEDBACK_WINDOW_ACCUM')
    exact_parallel_unsafe_feedback = exact_safe_feedback_slot_accum and ((not source_faithful_stereo) or source_segmented_safe_feedback) and env_flag('LOUDNORM_GPU_PARALLEL_UNSAFE_FEEDBACK', True)
    exact_skip_unsafe_feedback = exact_parallel_unsafe_feedback and exact_skip_safe_feedback and env_flag('LOUDNORM_GPU_SKIP_UNSAFE_FEEDBACK', True)
    exact_unsafe_skip_kernel_6ch = exact_parallel_unsafe_feedback and env_flag('LOUDNORM_GPU_UNSAFE_SKIP_KERNEL_6CH')
    exact_parallel_skip_safe_feedback = exact_skip_safe_feedback and env_flag('LOUDNORM_GPU_PARALLEL_SKIP_SAFE_FEEDBACK', True)
    exact_safe_skip_apply_frame_kernel = exact_parallel_skip_safe_feedback and env_flag('LOUDNORM_GPU_SAFE_SKIP_APPLY_FRAME_KERNEL')
    exact_safe_run_scan_apply_6ch = exact_parallel_skip_safe_feedback and env_flag('LOUDNORM_GPU_SAFE_RUN_SCAN_APPLY_6CH')
    exact_safe_run_scan_apply_post_fill = exact_safe_run_scan_apply_6ch and env_flag('LOUDNORM_GPU_SAFE_RUN_SCAN_APPLY_POST_FILL')
    exact_apply_fast_launch = exact_limiter_active and env_flag('LOUDNORM_GPU_APPLY_FAST_LAUNCH')
    gain_metrics_fast_launch = exact_limiter_active and env_flag('LOUDNORM_GPU_GAIN_METRICS_FAST_LAUNCH')
    exact_apply_arg_reuse = exact_limiter_active and env_flag('LOUDNORM_GPU_APPLY_ARG_REUSE')
    exact_stream_stage_device = exact_limiter_active and env_flag('LOUDNORM_GPU_EXACT_STREAM_STAGE_DEVICE')
    source_parallel_skip_before_threshold = source_exact_precompute and exact_parallel_skip_safe_feedback and env_flag('LOUDNORM_GPU_STEREO_SOURCE_PARALLEL_SKIP_BEFORE_THRESHOLD', True)
    source_unsafe_skip_kernel = source_exact_precompute and exact_parallel_unsafe_feedback and env_flag('LOUDNORM_GPU_STEREO_SOURCE_UNSAFE_SKIP_KERNEL', True)
    source_skip_limiter_lookahead_scan = source_exact_precompute and args.channels == 2 and env_flag('LOUDNORM_GPU_STEREO_SOURCE_SKIP_LIMITER_LOOKAHEAD_SCAN')
    source_fused_direct_feedback = source_exact_precompute and args.channels == 2 and env_flag('LOUDNORM_GPU_STEREO_SOURCE_FUSED_DIRECT_FEEDBACK')
    source_safe_run_scan_apply = source_exact_precompute and env_flag('LOUDNORM_GPU_SAFE_RUN_SCAN_APPLY')
    return SimpleNamespace(
        exact_stats_stream=exact_stats_stream,
        emit_first_pass_json=emit_first_pass_json,
        audit_ffmpeg_input_metrics=audit_ffmpeg_input_metrics,
        exact_prefix_channel_stats=exact_prefix_channel_stats,
        exact_stats_parallel_peaks=exact_stats_parallel_peaks,
        exact_stats_async_parallel_peaks=exact_stats_async_parallel_peaks,
        exact_channel_stats_warp=exact_channel_stats_warp,
        exact_channel_stats_no_peaks=exact_channel_stats_no_peaks,
        exact_channel_stats_unroll4=exact_channel_stats_unroll4,
        exact_channel_stats_cpu_native=exact_channel_stats_cpu_native,
        exact_channel_stats_checkpoint_replay=exact_channel_stats_checkpoint_replay,
        exact_paired_stats_fused_kernel=exact_paired_stats_fused_kernel,
        exact_stats_fast_launch=exact_stats_fast_launch,
        stats_prefetch_direct_h2d=stats_prefetch_direct_h2d,
        stats_prefetch_bytearray_direct_h2d=stats_prefetch_bytearray_direct_h2d,
        stats_prefetch_pinned_async_h2d=stats_prefetch_pinned_async_h2d,
        stats_prefetch_pinned_async_buffers=stats_prefetch_pinned_async_buffers,
        exact_stats_async_pipeline=exact_stats_async_pipeline,
        exact_stats_async_pinned_pipeline=exact_stats_async_pinned_pipeline,
        source_precompute_fast_launch=source_precompute_fast_launch,
        source_energy_packed=source_energy_packed,
        source_energy_coeff_hoist=source_energy_coeff_hoist,
        source_energy_packed_block_x=source_energy_packed_block_x,
        source_exact_split_sums=source_exact_split_sums,
        source_exact_split_unroll4=source_exact_split_unroll4,
        source_exact_split_pointer_walk=source_exact_split_pointer_walk,
        source_exact_split_readonly_loads=source_exact_split_readonly_loads,
        source_exact_sums_block_x=source_exact_sums_block_x,
        exact_profile_counts=exact_profile_counts,
        source_segmented_safe_feedback=source_segmented_safe_feedback,
        exact_prefill_output=exact_prefill_output,
        defer_safe_risk_gate_copy=defer_safe_risk_gate_copy,
        exact_safe_feedback_prefix_requested=exact_safe_feedback_prefix_requested,
        exact_use_prefilled_output=exact_use_prefilled_output,
        exact_sparse_chunks=exact_sparse_chunks,
        exact_skip_safe_fill=exact_skip_safe_fill,
        exact_segmented_safe_feedback=exact_segmented_safe_feedback,
        exact_skip_safe_feedback=exact_skip_safe_feedback,
        exact_force_safe_idle=exact_force_safe_idle,
        exact_safe_feedback_prefix=exact_safe_feedback_prefix,
        exact_safe_feedback_prefix_energy=exact_safe_feedback_prefix_energy,
        exact_safe_feedback_prefix_post_fill=exact_safe_feedback_prefix_post_fill,
        exact_safe_feedback_slot_accum=exact_safe_feedback_slot_accum,
        exact_safe_feedback_window_accum=exact_safe_feedback_window_accum,
        exact_parallel_unsafe_feedback=exact_parallel_unsafe_feedback,
        exact_skip_unsafe_feedback=exact_skip_unsafe_feedback,
        exact_unsafe_skip_kernel_6ch=exact_unsafe_skip_kernel_6ch,
        exact_parallel_skip_safe_feedback=exact_parallel_skip_safe_feedback,
        exact_safe_skip_apply_frame_kernel=exact_safe_skip_apply_frame_kernel,
        exact_safe_run_scan_apply_6ch=exact_safe_run_scan_apply_6ch,
        exact_safe_run_scan_apply_post_fill=exact_safe_run_scan_apply_post_fill,
        exact_apply_fast_launch=exact_apply_fast_launch,
        gain_metrics_fast_launch=gain_metrics_fast_launch,
        exact_apply_arg_reuse=exact_apply_arg_reuse,
        exact_stream_stage_device=exact_stream_stage_device,
        source_parallel_skip_before_threshold=source_parallel_skip_before_threshold,
        source_unsafe_skip_kernel=source_unsafe_skip_kernel,
        source_skip_limiter_lookahead_scan=source_skip_limiter_lookahead_scan,
        source_fused_direct_feedback=source_fused_direct_feedback,
        source_safe_run_scan_apply=source_safe_run_scan_apply,
    )


def derive_limiter_window_config(args, *, frames_per_window, effective_tp, linear_mode, exact_limiter_active, exact_skip_safe_fill, source_faithful_stereo, source_segmented_safe_feedback):
    ceiling = db_to_amp(effective_tp)
    apply_ceiling = 3.4028234663852886e38 if linear_mode else ceiling
    limiter_lookahead_frames = frame_size(args.rate, 210)
    limiter_alloc_frames = frame_size(args.rate, 3000)
    final_flush_frames = max(0, frames_per_window * 30 - frames_per_window)
    audit_input_tail_frames = frames_per_window * 30
    audit_input_replay_frames = final_flush_frames
    exact_skip_safe_fill_margin_frames = 0 if exact_skip_safe_fill else limiter_lookahead_frames
    if exact_skip_safe_fill:
        try:
            margin_windows = float(os.environ.get('LOUDNORM_GPU_SKIP_SAFE_FILL_MARGIN_WINDOWS', '0'))
            if margin_windows >= 0.0:
                exact_skip_safe_fill_margin_frames = int(margin_windows * frames_per_window)
        except ValueError:
            exact_skip_safe_fill_margin_frames = 0
    risk_expand_env = os.environ.get('LOUDNORM_GPU_RISK_EXPAND_WINDOWS')
    exact_risk_expand_windows = 1
    if exact_limiter_active:
        try:
            exact_risk_expand_windows = max(0, int(risk_expand_env if risk_expand_env is not None else str(exact_risk_expand_windows)))
        except ValueError:
            exact_risk_expand_windows = 3
    exact_risk_expand_before_windows = exact_risk_expand_windows
    exact_risk_expand_after_windows = exact_risk_expand_windows
    # Keep the risk map slightly conservative: dynamic feedback can lift later gains enough
    # that near-ceiling windows otherwise get misclassified as safe on long 2ch renders.
    exact_risk_ceiling_scale = 0.97
    exact_use_risk_map = exact_limiter_active and ((not source_faithful_stereo) or source_segmented_safe_feedback)
    risk_run_cache = exact_use_risk_map and env_flag('LOUDNORM_GPU_RISK_RUN_CACHE')
    if exact_limiter_active:
        try:
            exact_risk_expand_before_windows = max(0, int(os.environ.get('LOUDNORM_GPU_RISK_EXPAND_BEFORE_WINDOWS', str(exact_risk_expand_before_windows))))
        except ValueError:
            exact_risk_expand_before_windows = exact_risk_expand_windows
        try:
            exact_risk_expand_after_windows = max(0, int(os.environ.get('LOUDNORM_GPU_RISK_EXPAND_AFTER_WINDOWS', str(exact_risk_expand_after_windows))))
        except ValueError:
            exact_risk_expand_after_windows = exact_risk_expand_windows
        try:
            exact_risk_ceiling_scale = max(0.0, float(os.environ.get('LOUDNORM_GPU_RISK_CEILING_SCALE', str(exact_risk_ceiling_scale))))
        except ValueError:
            exact_risk_ceiling_scale = 1.0
    return SimpleNamespace(
        ceiling=ceiling,
        apply_ceiling=apply_ceiling,
        limiter_lookahead_frames=limiter_lookahead_frames,
        limiter_alloc_frames=limiter_alloc_frames,
        final_flush_frames=final_flush_frames,
        audit_input_tail_frames=audit_input_tail_frames,
        audit_input_replay_frames=audit_input_replay_frames,
        exact_skip_safe_fill_margin_frames=exact_skip_safe_fill_margin_frames,
        exact_risk_expand_windows=exact_risk_expand_windows,
        exact_risk_expand_before_windows=exact_risk_expand_before_windows,
        exact_risk_expand_after_windows=exact_risk_expand_after_windows,
        exact_risk_ceiling_scale=exact_risk_ceiling_scale,
        exact_use_risk_map=exact_use_risk_map,
        risk_run_cache=risk_run_cache,
    )


def derive_chunk_sizing_config(args, *, input_sample_bytes, nbytes, frames_per_window, exact_limiter_active, source_config, limiter_config):
    chunk_bytes = int(args.chunk_mib * 1024 * 1024)
    frame_bytes = args.channels * input_sample_bytes
    audit_input_tail_bytes = limiter_config.audit_input_tail_frames * frame_bytes
    window_bytes = frames_per_window * frame_bytes
    chunk_bytes = max(window_bytes, chunk_bytes - (chunk_bytes % window_bytes))
    chunk_bytes = min(chunk_bytes, nbytes)
    exact_unsafe_chunk_bytes = chunk_bytes
    exact_safe_chunk_bytes = chunk_bytes
    if exact_limiter_active:
        try:
            exact_safe_chunk_mib = max(0.0, float(os.environ.get('LOUDNORM_GPU_EXACT_SAFE_CHUNK_MIB', '0')))
        except ValueError:
            exact_safe_chunk_mib = 0.0
        if exact_safe_chunk_mib > 0.0:
            safe_chunk_bytes = int(exact_safe_chunk_mib * 1024 * 1024)
            safe_chunk_bytes = max(window_bytes, safe_chunk_bytes - (safe_chunk_bytes % window_bytes))
            safe_chunk_bytes = min(safe_chunk_bytes, nbytes)
            exact_safe_chunk_bytes = max(chunk_bytes, safe_chunk_bytes)
            chunk_bytes = max(chunk_bytes, exact_safe_chunk_bytes)
        try:
            exact_unsafe_chunk_mib = max(0.0, float(os.environ.get('LOUDNORM_GPU_EXACT_UNSAFE_CHUNK_MIB', '0')))
        except ValueError:
            exact_unsafe_chunk_mib = 0.0
        if exact_unsafe_chunk_mib > 0.0:
            unsafe_chunk_bytes = int(exact_unsafe_chunk_mib * 1024 * 1024)
            unsafe_chunk_bytes = max(window_bytes, unsafe_chunk_bytes - (unsafe_chunk_bytes % window_bytes))
            unsafe_chunk_bytes = min(unsafe_chunk_bytes, nbytes)
            exact_unsafe_chunk_bytes = max(chunk_bytes, unsafe_chunk_bytes)
            chunk_bytes = max(chunk_bytes, exact_unsafe_chunk_bytes)
    stats_chunk_windows = 1
    if exact_limiter_active and args.input_format == 'f64le':
        try:
            stats_chunk_windows = max(1, int(os.environ.get('LOUDNORM_GPU_STATS_CHUNK_WINDOWS', '1')))
        except ValueError:
            stats_chunk_windows = 1
        if source_config.source_exact_precompute:
            try:
                stats_chunk_windows = max(1, int(os.environ.get('LOUDNORM_GPU_SOURCE_STATS_CHUNK_WINDOWS', '2')))
            except ValueError:
                stats_chunk_windows = 2
    stats_chunk_bytes = min(nbytes, max(window_bytes, stats_chunk_windows * window_bytes))
    exact_channel_stats_combined_peaks = exact_limiter_active and args.input_format == 'f64le' and env_flag('LOUDNORM_GPU_CHANNEL_STATS_COMBINED_PEAKS')
    source_precompute_windows = 0
    source_precompute_chunk_bytes = chunk_bytes
    source_precompute_stage_bytes = chunk_bytes
    source_block_sum_bytes = 0
    source_energy_stage_needed = source_config.source_exact_precompute and ((not source_config.source_precompute_from_channel_sums) or source_config.source_channel_hist4_exact or source_config.source_channel_short_exact or source_config.source_channel_short_boundary)
    source_stage_needed = source_energy_stage_needed or source_config.source_channel_hist4_boundary
    if source_stage_needed:
        try:
            source_precompute_windows = max(1, int(os.environ.get('LOUDNORM_GPU_STEREO_SOURCE_PRECOMPUTE_WINDOWS', '1024')))
        except ValueError:
            source_precompute_windows = 1024
        try:
            source_precompute_stage_mib = max(1.0, float(os.environ.get('LOUDNORM_GPU_STEREO_SOURCE_PRECOMPUTE_STAGE_MIB', '384')))
        except ValueError:
            source_precompute_stage_mib = 384.0
        max_stage_bytes = int(source_precompute_stage_mib * 1024 * 1024)
        source_precompute_stage_extra_windows = 29 + (stats_chunk_windows if (source_config.source_precompute_device_input or source_config.source_stage_fixed_buffer) else 0)
        max_stage_windows = max(1, (max_stage_bytes // window_bytes) - source_precompute_stage_extra_windows)
        source_precompute_windows = min(source_precompute_windows, max_stage_windows)
        source_precompute_chunk_bytes = min(nbytes, max(window_bytes, source_precompute_windows * window_bytes))
        source_precompute_stage_bytes = min(nbytes, (source_precompute_windows + source_precompute_stage_extra_windows) * window_bytes)
        if source_config.source_block_sum_candidate:
            source_precompute_stage_frames = max(1, source_precompute_stage_bytes // frame_bytes)
            source_block_sum_blocks = (source_precompute_stage_frames + source_config.source_block_frames - 1) // source_config.source_block_frames
            source_block_sum_bytes = max(1, source_block_sum_blocks + 1) * args.channels * 8
    apply_input_chunk_bytes = chunk_bytes
    if exact_limiter_active:
        apply_input_chunk_bytes = chunk_bytes + (max(limiter_config.limiter_lookahead_frames, limiter_config.final_flush_frames) * frame_bytes)
        if source_config.source_faithful_stereo:
            apply_input_chunk_bytes = chunk_bytes + (max(limiter_config.limiter_lookahead_frames, limiter_config.final_flush_frames, frames_per_window * 30) * frame_bytes)
        exact_apply_input_chunk_bytes = apply_input_chunk_bytes
        if source_stage_needed:
            apply_input_chunk_bytes = max(apply_input_chunk_bytes, source_precompute_stage_bytes)
    else:
        exact_apply_input_chunk_bytes = apply_input_chunk_bytes
    output_sample_bytes = 8 if args.output_format == 'f64le' else 4
    output_chunk_bytes = (chunk_bytes // input_sample_bytes) * output_sample_bytes
    return SimpleNamespace(
        chunk_bytes=chunk_bytes,
        frame_bytes=frame_bytes,
        audit_input_tail_bytes=audit_input_tail_bytes,
        window_bytes=window_bytes,
        exact_unsafe_chunk_bytes=exact_unsafe_chunk_bytes,
        exact_safe_chunk_bytes=exact_safe_chunk_bytes,
        stats_chunk_windows=stats_chunk_windows,
        stats_chunk_bytes=stats_chunk_bytes,
        exact_channel_stats_combined_peaks=exact_channel_stats_combined_peaks,
        source_precompute_windows=source_precompute_windows,
        source_precompute_chunk_bytes=source_precompute_chunk_bytes,
        source_precompute_stage_bytes=source_precompute_stage_bytes,
        source_block_sum_bytes=source_block_sum_bytes,
        source_energy_stage_needed=source_energy_stage_needed,
        source_stage_needed=source_stage_needed,
        apply_input_chunk_bytes=apply_input_chunk_bytes,
        exact_apply_input_chunk_bytes=exact_apply_input_chunk_bytes,
        output_sample_bytes=output_sample_bytes,
        output_chunk_bytes=output_chunk_bytes,
    )
