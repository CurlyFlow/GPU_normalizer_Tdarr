from __future__ import annotations

from types import SimpleNamespace


PAIRED_STATS_RESET = {
    'paired_stats_decode_command_json': None,
    'paired_stats_combined_decode_command_json': None,
    'paired_stats_combined_channels': 0,
    'paired_stats_cache_output': None,
    'paired_stats_channels': 0,
    'paired_stats_rate': 0,
    'paired_stats_stereo_fallback_source_exact': False,
}

PAIRED_APPLY_RESET = {
    'paired_apply_decode_command_json': None,
    'paired_apply_encode_command_json': None,
    'paired_apply_stats_cache_input': None,
    'paired_apply_channels': 0,
    'paired_apply_rate': 0,
    'paired_apply_chunk_mib': 0.0,
    'paired_apply_measured_i': None,
    'paired_apply_measured_lra': None,
    'paired_apply_measured_tp': None,
    'paired_apply_measured_thresh': None,
    'paired_apply_offset_db': None,
    'paired_apply_stereo_fallback_source_exact': False,
}


def build_secondary_runtime_args(args, overrides, *, reset_apply=False):
    values = vars(args).copy()
    values.update(overrides)
    values.update(PAIRED_STATS_RESET)
    if reset_apply:
        values.update(PAIRED_APPLY_RESET)
    return SimpleNamespace(**values)


def build_paired_stats_args(args):
    return build_secondary_runtime_args(args, {
        'rate': args.paired_stats_rate if args.paired_stats_rate > 0 else args.rate,
        'channels': args.paired_stats_channels,
        'decode_command_json': args.paired_stats_decode_command_json,
        'encode_command_json': None,
        'stats_cache_output': args.paired_stats_cache_output,
        'stats_cache_input': None,
        'stats_cache_only': True,
        'stereo_fallback_source_exact': bool(args.paired_stats_stereo_fallback_source_exact),
    })


def build_paired_apply_args(args):
    return build_secondary_runtime_args(args, {
        'rate': args.paired_apply_rate if args.paired_apply_rate > 0 else args.rate,
        'channels': args.paired_apply_channels,
        'chunk_mib': args.paired_apply_chunk_mib if args.paired_apply_chunk_mib > 0 else args.chunk_mib,
        'decode_command_json': args.paired_apply_decode_command_json,
        'encode_command_json': args.paired_apply_encode_command_json,
        'stats_cache_output': None,
        'stats_cache_input': args.paired_apply_stats_cache_input,
        'stats_cache_only': False,
        'measured_i': args.paired_apply_measured_i,
        'measured_lra': args.paired_apply_measured_lra,
        'measured_tp': args.paired_apply_measured_tp,
        'measured_thresh': args.paired_apply_measured_thresh,
        'offset_db': args.paired_apply_offset_db,
        'stereo_fallback_source_exact': bool(args.paired_apply_stereo_fallback_source_exact),
    }, reset_apply=True)
