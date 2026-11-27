from __future__ import annotations

from dataclasses import dataclass

from runtime_env import env_flag, env_float, env_int, env_int_unbounded, env_nonnegative_int


@dataclass(frozen=True)
class SourcePrecomputeConfig:
    source_faithful_stereo: bool
    source_exact_precompute: bool
    source_precompute_from_channel_sums: bool
    source_channel_hist4_exact: bool
    source_channel_hist4_boundary: bool
    source_channel_short_exact: bool
    source_channel_short_boundary: bool
    source_channel_short_raw_boundary: bool
    source_channel_short_margin_lu: float
    source_channel_short_halo_windows: int
    source_channel_hist4_margin_lu: float
    source_channel_hist4_margin_ratio: float
    source_precompute_in_stats: bool
    source_sum_audit: bool
    source_block_sums: bool
    source_block_sum_candidate: bool
    source_precompute_device_energy: bool
    source_precompute_device_input: bool
    source_stage_direct_h2d: bool
    source_stage_fixed_buffer: bool
    source_block_frames: int
    source_block_exact_after_window: int
    source_block_exact_until_window: int


def derive_source_precompute_config(args, *, exact_limiter_requested, frames_per_window):
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
    source_channel_short_margin_lu = env_float('LOUDNORM_GPU_STEREO_SOURCE_CHANNEL_SHORT_MARGIN_LU', 0.001, minimum=0.0)
    source_channel_short_halo_windows = env_nonnegative_int('LOUDNORM_GPU_STEREO_SOURCE_CHANNEL_SHORT_HALO_WINDOWS', 30)
    source_channel_hist4_margin_lu = env_float('LOUDNORM_GPU_STEREO_SOURCE_CHANNEL_HIST4_MARGIN_LU', 0.005, minimum=0.0)
    source_channel_hist4_margin_ratio = 10.0 ** (source_channel_hist4_margin_lu / 10.0)

    source_precompute_in_stats = source_exact_precompute and (not source_precompute_from_channel_sums) and env_flag('LOUDNORM_GPU_STEREO_SOURCE_PRECOMPUTE_IN_STATS', True)
    source_sum_audit = source_exact_precompute and (not source_precompute_from_channel_sums) and env_flag('LOUDNORM_GPU_STEREO_SOURCE_SUM_AUDIT')
    source_block_sums = source_exact_precompute and (not source_precompute_from_channel_sums) and env_flag('LOUDNORM_GPU_STEREO_SOURCE_BLOCK_SUMS')
    source_block_sum_candidate = source_exact_precompute and (not source_precompute_from_channel_sums) and (source_sum_audit or source_block_sums)
    source_precompute_device_energy = source_precompute_in_stats and args.channels == 2 and not source_sum_audit and not source_block_sum_candidate and env_flag('LOUDNORM_GPU_STEREO_SOURCE_PRECOMPUTE_DEVICE_ENERGY', False)
    source_precompute_device_input = source_precompute_in_stats and args.channels == 2 and not source_precompute_device_energy and not source_sum_audit and not source_block_sum_candidate and env_flag('LOUDNORM_GPU_STEREO_SOURCE_PRECOMPUTE_DEVICE_INPUT', False)
    source_stage_direct_h2d = source_exact_precompute and (not source_precompute_device_energy) and (not source_precompute_device_input) and env_flag('LOUDNORM_GPU_SOURCE_STAGE_DIRECT_H2D')
    source_stage_fixed_buffer = source_precompute_in_stats and (not source_precompute_device_energy) and (not source_precompute_device_input) and env_flag('LOUDNORM_GPU_SOURCE_STAGE_FIXED_BUFFER')
    source_block_frames = min(env_int('LOUDNORM_GPU_STEREO_SOURCE_BLOCK_FRAMES', 64, minimum=1), frames_per_window)
    source_block_exact_after_window = env_int_unbounded('LOUDNORM_GPU_STEREO_SOURCE_BLOCK_EXACT_AFTER_WINDOW', -1)
    source_block_exact_until_window = env_int_unbounded('LOUDNORM_GPU_STEREO_SOURCE_BLOCK_EXACT_UNTIL_WINDOW', -1)

    return SourcePrecomputeConfig(
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
        source_block_frames=source_block_frames,
        source_block_exact_after_window=source_block_exact_after_window,
        source_block_exact_until_window=source_block_exact_until_window,
    )
