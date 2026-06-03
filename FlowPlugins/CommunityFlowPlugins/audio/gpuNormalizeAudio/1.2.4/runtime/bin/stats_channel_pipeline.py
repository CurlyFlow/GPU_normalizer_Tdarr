from __future__ import annotations

from dataclasses import dataclass


@dataclass
class SourceStageConfig:
    audit_tail: bytearray | None
    source_energy_capacity_frames: int
    source_input_capacity_frames: int
    source_overlap_frames: int
    source_stage: bytearray | None
    source_stage_needed: bool
    use_source_device_energy: bool
    use_source_device_input: bool
    use_source_fixed_buffer: bool


def create_source_stage_config(cfg, *, allow_fixed_buffer=False):
    use_source_device_energy = bool(cfg.source_precompute_device_energy)
    use_source_device_input = bool(getattr(cfg, 'source_precompute_device_input', False))
    use_source_fixed_buffer = bool(getattr(cfg, 'source_stage_fixed_buffer', False)) and allow_fixed_buffer and not (use_source_device_energy or use_source_device_input)
    source_stage_needed = bool(
        cfg.source_precompute_in_stats
        or cfg.source_channel_hist4_exact
        or cfg.source_channel_hist4_boundary
        or cfg.source_channel_short_exact
        or cfg.source_channel_short_boundary
    )
    if use_source_device_energy or use_source_device_input or not source_stage_needed:
        source_stage = None
    elif use_source_fixed_buffer:
        source_stage = bytearray(cfg.source_precompute_stage_bytes)
    else:
        source_stage = bytearray()
    return SourceStageConfig(
        audit_tail=bytearray() if (cfg.audit_ffmpeg_input_metrics or cfg.emit_first_pass_json) else None,
        source_energy_capacity_frames=cfg.source_precompute_stage_bytes // cfg.frame_bytes if use_source_device_energy else 0,
        source_input_capacity_frames=cfg.source_precompute_stage_bytes // cfg.frame_bytes if use_source_device_input else 0,
        source_overlap_frames=cfg.frames_per_window * 29,
        source_stage=source_stage,
        source_stage_needed=source_stage_needed,
        use_source_device_energy=use_source_device_energy,
        use_source_device_input=use_source_device_input,
        use_source_fixed_buffer=use_source_fixed_buffer,
    )


def ensure_default_channel_stats_path(cfg, label):
    if cfg.exact_stats_async_pipeline or cfg.exact_stats_parallel_peaks or cfg.exact_channel_stats_combined_peaks:
        raise RuntimeError(f'{label} supports the default exact channel stats path only')
