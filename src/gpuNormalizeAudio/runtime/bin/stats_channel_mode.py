from __future__ import annotations

from dataclasses import dataclass

from cuda_driver import has_async_apply_api
from stats_channel_pipeline import SourceStageConfig, create_source_stage_config


@dataclass(frozen=True)
class ChannelStatsMode:
    source_stage_config: SourceStageConfig
    use_combined_peaks: bool
    use_checkpoint_replay: bool
    use_channel_warp: bool
    channel_grid_x: int
    channel_block_x: int
    cuda_has_async_api: bool
    use_async_parallel_peaks_requested: bool
    use_parallel_peaks: bool
    use_pinned_async_pipeline: bool
    use_async_pipeline: bool
    use_async_parallel_peaks: bool
    use_direct_pinned_prefetch: bool
    direct_stats_bytearray_payload: bool
    direct_stats_bytes_payload: bool


def create_channel_stats_mode(ctx):
    args = ctx.args
    cfg = ctx.cfg
    source_stage_config = create_source_stage_config(cfg, allow_fixed_buffer=True)
    use_source_device_energy = source_stage_config.use_source_device_energy
    use_source_device_input = source_stage_config.use_source_device_input
    use_combined_peaks = bool(cfg.sizing.exact_channel_stats_combined_peaks)
    use_checkpoint_replay = bool(
        getattr(cfg.exact, 'exact_channel_stats_checkpoint_replay', False)
        and not use_source_device_energy
        and not use_source_device_input
        and not use_combined_peaks
        and not getattr(cfg.exact, 'exact_channel_stats_no_peaks', False)
    )
    use_channel_warp = bool(
        getattr(cfg.exact, 'exact_channel_stats_warp', False)
        and not use_checkpoint_replay
        and not use_source_device_energy
        and not getattr(cfg.exact, 'exact_channel_stats_no_peaks', False)
    )
    channel_grid_x = 1 if use_channel_warp else args.channels
    channel_block_x = 32 if use_channel_warp else 1
    cuda_has_async_api = has_async_apply_api(ctx.cuda)
    use_async_parallel_peaks_requested = bool(
        (not use_checkpoint_replay)
        and (not use_combined_peaks)
        and getattr(cfg.exact, 'exact_stats_async_parallel_peaks', False)
        and cuda_has_async_api
        and hasattr(ctx.cuda, 'cuStreamWaitEvent')
    )
    use_parallel_peaks = bool(
        (not use_checkpoint_replay)
        and (not use_combined_peaks)
        and cfg.exact.exact_stats_parallel_peaks
        and cuda_has_async_api
        and not use_async_parallel_peaks_requested
    )
    use_pinned_async_pipeline = bool(
        getattr(cfg.exact, 'exact_stats_async_pinned_pipeline', False)
        and cuda_has_async_api
        and not use_parallel_peaks
        and not use_combined_peaks
        and ctx.buffers.d_stats_in_b.value
    )
    use_async_pipeline = use_pinned_async_pipeline or bool(
        cfg.exact.exact_stats_async_pipeline
        and cuda_has_async_api
        and not use_parallel_peaks
        and not use_combined_peaks
        and not getattr(ctx.host_io, 'pinned', 0)
        and ctx.buffers.d_stats_in_b.value
    )
    use_async_parallel_peaks = bool(use_async_pipeline and use_async_parallel_peaks_requested)
    use_direct_pinned_prefetch = bool(
        use_pinned_async_pipeline
        and getattr(cfg.exact, 'stats_prefetch_pinned_async_h2d', False)
    )
    direct_stats_bytearray_payload = bool(getattr(cfg.exact, 'stats_prefetch_bytearray_direct_h2d', False) and not use_async_pipeline)
    direct_stats_bytearray_payload = direct_stats_bytearray_payload or use_direct_pinned_prefetch
    direct_stats_bytes_payload = bool(getattr(cfg.exact, 'stats_prefetch_direct_h2d', False) and not use_async_pipeline and not direct_stats_bytearray_payload)
    return ChannelStatsMode(
        source_stage_config=source_stage_config,
        use_combined_peaks=use_combined_peaks,
        use_checkpoint_replay=use_checkpoint_replay,
        use_channel_warp=use_channel_warp,
        channel_grid_x=channel_grid_x,
        channel_block_x=channel_block_x,
        cuda_has_async_api=cuda_has_async_api,
        use_async_parallel_peaks_requested=use_async_parallel_peaks_requested,
        use_parallel_peaks=use_parallel_peaks,
        use_pinned_async_pipeline=use_pinned_async_pipeline,
        use_async_pipeline=use_async_pipeline,
        use_async_parallel_peaks=use_async_parallel_peaks,
        use_direct_pinned_prefetch=use_direct_pinned_prefetch,
        direct_stats_bytearray_payload=direct_stats_bytearray_payload,
        direct_stats_bytes_payload=direct_stats_bytes_payload,
    )
