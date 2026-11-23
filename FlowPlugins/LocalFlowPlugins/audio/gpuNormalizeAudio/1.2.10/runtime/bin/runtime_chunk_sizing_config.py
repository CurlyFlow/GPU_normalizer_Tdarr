from __future__ import annotations

from dataclasses import dataclass

from runtime_env import env_flag, env_float, env_int, env_nonnegative_int


@dataclass(frozen=True)
class ChunkSizingConfig:
    chunk_bytes: int
    frame_bytes: int
    audit_input_tail_bytes: int
    window_bytes: int
    exact_unsafe_chunk_bytes: int
    exact_safe_chunk_bytes: int
    exact_safe_skip_chunk_bytes: int
    stats_chunk_windows: int
    stats_chunk_bytes: int
    exact_channel_stats_combined_peaks: bool
    source_precompute_windows: int
    source_precompute_chunk_bytes: int
    source_precompute_stage_bytes: int
    source_block_sum_bytes: int
    source_energy_stage_needed: bool
    source_stage_needed: bool
    apply_input_chunk_bytes: int
    exact_apply_input_chunk_bytes: int
    output_sample_bytes: int
    output_chunk_bytes: int


def derive_chunk_sizing_config(args, *, input_sample_bytes, nbytes, frames_per_window, exact_limiter_active, source_config, limiter_config):
    chunk_bytes = int(args.chunk_mib * 1024 * 1024)
    frame_bytes = args.channels * input_sample_bytes
    audit_input_tail_bytes = limiter_config.audit_input_tail_frames * frame_bytes
    window_bytes = frames_per_window * frame_bytes
    chunk_bytes = max(window_bytes, chunk_bytes - (chunk_bytes % window_bytes))
    chunk_bytes = min(chunk_bytes, nbytes)
    exact_unsafe_chunk_bytes = chunk_bytes
    exact_safe_chunk_bytes = chunk_bytes
    exact_safe_skip_chunk_bytes = 0
    if exact_limiter_active:
        exact_safe_chunk_mib = env_float('LOUDNORM_GPU_EXACT_SAFE_CHUNK_MIB', 0.0, minimum=0.0)
        if exact_safe_chunk_mib > 0.0:
            safe_chunk_bytes = int(exact_safe_chunk_mib * 1024 * 1024)
            safe_chunk_bytes = max(window_bytes, safe_chunk_bytes - (safe_chunk_bytes % window_bytes))
            safe_chunk_bytes = min(safe_chunk_bytes, nbytes)
            exact_safe_chunk_bytes = max(chunk_bytes, safe_chunk_bytes)
            chunk_bytes = max(chunk_bytes, exact_safe_chunk_bytes)
        exact_unsafe_chunk_mib = env_float('LOUDNORM_GPU_EXACT_UNSAFE_CHUNK_MIB', 0.0, minimum=0.0)
        if exact_unsafe_chunk_mib > 0.0:
            unsafe_chunk_bytes = int(exact_unsafe_chunk_mib * 1024 * 1024)
            unsafe_chunk_bytes = max(window_bytes, unsafe_chunk_bytes - (unsafe_chunk_bytes % window_bytes))
            unsafe_chunk_bytes = min(unsafe_chunk_bytes, nbytes)
            exact_unsafe_chunk_bytes = max(chunk_bytes, unsafe_chunk_bytes)
            chunk_bytes = max(chunk_bytes, exact_unsafe_chunk_bytes)
        safe_skip_chunk_windows = env_nonnegative_int('LOUDNORM_GPU_SAFE_SKIP_CHUNK_WINDOWS', 0)
        if safe_skip_chunk_windows > 0:
            safe_skip_chunk_bytes = min(nbytes, max(window_bytes, safe_skip_chunk_windows * window_bytes))
            exact_safe_skip_chunk_bytes = max(chunk_bytes, safe_skip_chunk_bytes)
    stats_chunk_windows = 1
    if exact_limiter_active and args.input_format == 'f64le':
        stats_chunk_windows = env_int('LOUDNORM_GPU_STATS_CHUNK_WINDOWS', 1, minimum=1)
        if source_config.source_exact_precompute:
            stats_chunk_windows = env_int('LOUDNORM_GPU_SOURCE_STATS_CHUNK_WINDOWS', 2, minimum=1)
    stats_chunk_bytes = min(nbytes, max(window_bytes, stats_chunk_windows * window_bytes))
    exact_channel_stats_combined_peaks = exact_limiter_active and args.input_format == 'f64le' and env_flag('LOUDNORM_GPU_CHANNEL_STATS_COMBINED_PEAKS')
    source_precompute_windows = 0
    source_precompute_chunk_bytes = chunk_bytes
    source_precompute_stage_bytes = chunk_bytes
    source_block_sum_bytes = 0
    source_energy_stage_needed = source_config.source_exact_precompute and ((not source_config.source_precompute_from_channel_sums) or source_config.source_channel_hist4_exact or source_config.source_channel_short_exact or source_config.source_channel_short_boundary)
    source_stage_needed = source_energy_stage_needed or source_config.source_channel_hist4_boundary
    if source_stage_needed:
        source_precompute_windows = env_int('LOUDNORM_GPU_STEREO_SOURCE_PRECOMPUTE_WINDOWS', 1024, minimum=1)
        source_precompute_stage_mib = env_float('LOUDNORM_GPU_STEREO_SOURCE_PRECOMPUTE_STAGE_MIB', 384.0, minimum=1.0)
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
    exact_apply_capacity_chunk_bytes = max(chunk_bytes, exact_safe_skip_chunk_bytes)
    apply_input_chunk_bytes = exact_apply_capacity_chunk_bytes
    if exact_limiter_active:
        apply_input_chunk_bytes = exact_apply_capacity_chunk_bytes + (max(limiter_config.limiter_lookahead_frames, limiter_config.final_flush_frames) * frame_bytes)
        if source_config.source_faithful_stereo:
            apply_input_chunk_bytes = exact_apply_capacity_chunk_bytes + (max(limiter_config.limiter_lookahead_frames, limiter_config.final_flush_frames, frames_per_window * 30) * frame_bytes)
        exact_apply_input_chunk_bytes = apply_input_chunk_bytes
        if source_stage_needed:
            apply_input_chunk_bytes = max(apply_input_chunk_bytes, source_precompute_stage_bytes)
    else:
        exact_apply_input_chunk_bytes = apply_input_chunk_bytes
    output_sample_bytes = 8 if args.output_format == 'f64le' else 4
    output_capacity_chunk_bytes = exact_apply_capacity_chunk_bytes if exact_limiter_active else chunk_bytes
    output_chunk_bytes = (output_capacity_chunk_bytes // input_sample_bytes) * output_sample_bytes
    return ChunkSizingConfig(
        chunk_bytes=chunk_bytes,
        frame_bytes=frame_bytes,
        audit_input_tail_bytes=audit_input_tail_bytes,
        window_bytes=window_bytes,
        exact_unsafe_chunk_bytes=exact_unsafe_chunk_bytes,
        exact_safe_chunk_bytes=exact_safe_chunk_bytes,
        exact_safe_skip_chunk_bytes=exact_safe_skip_chunk_bytes,
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
