from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class InputShapeConfig:
    decode_command: object
    encode_command: object
    frames_per_window: int
    ingress_rate: int
    mib: float
    nbytes: int
    paired_stats_active: bool
    paired_stats_combined_decode_command: object
    seconds: float
    total_frames: int
    total_samples: int
    windows: int


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
    ingress_rate = int(args.ingress_rate or 0)
    if ingress_rate <= 0:
        ingress_rate = args.rate
    if ingress_rate != args.rate and not streaming_io:
        raise SystemExit('--ingress-rate requires --streaming-io')
    if ingress_rate != args.rate and args.input_format != 'f64le':
        raise SystemExit('--ingress-rate currently requires f64le input')

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
    return InputShapeConfig(
        decode_command=decode_command,
        encode_command=encode_command,
        frames_per_window=frames_per_window,
        ingress_rate=ingress_rate,
        mib=mib,
        nbytes=nbytes,
        paired_stats_active=paired_stats_active,
        paired_stats_combined_decode_command=paired_stats_combined_decode_command,
        seconds=seconds,
        total_frames=total_frames,
        total_samples=total_samples,
        windows=windows,
    )
