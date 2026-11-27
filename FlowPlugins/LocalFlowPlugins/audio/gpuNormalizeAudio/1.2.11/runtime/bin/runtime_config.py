from __future__ import annotations

from dataclasses import dataclass, replace

from runtime_chunk_sizing_config import ChunkSizingConfig, derive_chunk_sizing_config
from runtime_exact_features import ExactFeatureConfig, derive_exact_feature_config
from runtime_input_shape_config import InputShapeConfig, derive_input_shape
from runtime_limiter_window_config import LimiterWindowConfig, derive_limiter_window_config
from runtime_loudnorm_mode_config import LoudnormModeConfig, derive_loudnorm_mode
from runtime_source_precompute_config import SourcePrecomputeConfig, derive_source_precompute_config
from runtime_args import parse_runtime_args

@dataclass(frozen=True)
class RuntimeRootConfig:
    input_sample_bytes: int
    streaming_io: bool
    stats_cache_only: bool


@dataclass
class RuntimeConfig:
    root: RuntimeRootConfig
    input_shape: InputShapeConfig
    loudnorm_mode: LoudnormModeConfig
    source: SourcePrecomputeConfig
    exact: ExactFeatureConfig
    limiter: LimiterWindowConfig
    sizing: ChunkSizingConfig


def derive_runtime_config(args):
    if args.input_format == 'f64le' and args.output_format != 'f64le':
        raise SystemExit('f64le input currently requires f64le output')
    if args.ingress_rate and args.ingress_rate != args.rate and not args.streaming_io:
        raise SystemExit('--ingress-rate requires --streaming-io')
    if args.emit_first_pass_input_json and not args.stats_cache_only:
        raise SystemExit('--emit-first-pass-input-json requires --stats-cache-only')
    input_sample_bytes = 8 if args.input_format == 'f64le' else 4
    streaming_io = bool(args.streaming_io)
    stats_cache_only = bool(args.stats_cache_only)

    input_shape = derive_input_shape(args, input_sample_bytes=input_sample_bytes, streaming_io=streaming_io, stats_cache_only=stats_cache_only)
    loudnorm_mode = derive_loudnorm_mode(args, stats_cache_only=stats_cache_only)

    source_config = derive_source_precompute_config(
        args,
        exact_limiter_requested=loudnorm_mode.exact_limiter_requested,
        frames_per_window=input_shape.frames_per_window,
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

    return RuntimeConfig(
        root=RuntimeRootConfig(
            input_sample_bytes=input_sample_bytes,
            streaming_io=streaming_io,
            stats_cache_only=stats_cache_only,
        ),
        input_shape=input_shape,
        loudnorm_mode=loudnorm_mode,
        source=source_config,
        exact=exact_config,
        limiter=limiter_config,
        sizing=sizing_config,
    )


def apply_stats_result_to_config(cfg, stats_result):
    input_shape = replace(
        cfg.input_shape,
        nbytes=stats_result.nbytes,
        mib=stats_result.mib,
        total_samples=stats_result.total_samples,
        total_frames=stats_result.total_frames,
        windows=stats_result.windows,
        seconds=stats_result.seconds,
    )
    updated = replace(cfg, input_shape=input_shape)
    if hasattr(cfg, '_ffmpeg_input_metric_values'):
        updated._ffmpeg_input_metric_values = cfg._ffmpeg_input_metric_values
    return updated
