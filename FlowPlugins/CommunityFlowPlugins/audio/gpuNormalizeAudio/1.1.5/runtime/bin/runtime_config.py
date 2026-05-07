from __future__ import annotations

import argparse
import json
import math
import os
from types import SimpleNamespace

from loudnorm_math import db_to_amp, frame_size


RUNTIME_BIN = os.path.dirname(os.path.abspath(__file__))
RUNTIME_ROOT = os.path.dirname(RUNTIME_BIN)
PLUGIN_ROOT = os.path.dirname(RUNTIME_ROOT)
RUNTIME_CUDA = os.path.join(RUNTIME_ROOT, 'cuda')


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
    parser.add_argument('--chunk-mib', type=float, default=64.0)
    parser.add_argument('--max-pcm-mib', type=float, default=8192.0)
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
    parser.add_argument('--parallel-final-apply', action='store_true', help='Experimental: use parallel f64 apply with FFmpeg final-flush timing after exact source-port gain planning.')
    return parser.parse_args(argv)


def env_flag(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value in ('1', 'true', 'TRUE', 'yes', 'YES')


def _load_command_json(value, label):
    command = json.loads(value)
    if not (isinstance(command, list) and command and all(isinstance(v, str) for v in command)):
        raise SystemExit(f'{label} must be a JSON string array')
    return command


def derive_runtime_config(args):
    if args.input_format == 'f64le' and args.output_format != 'f64le':
        raise SystemExit('f64le input currently requires f64le output')
    input_sample_bytes = 8 if args.input_format == 'f64le' else 4
    streaming_io = bool(args.streaming_io)
    if streaming_io and args.input_format != 'f64le':
        raise SystemExit('--streaming-io currently requires f64le input')
    decode_command = None
    encode_command = None
    if streaming_io:
        if not args.decode_command_json or not args.encode_command_json:
            raise SystemExit('--streaming-io requires --decode-command-json and --encode-command-json')
        decode_command = _load_command_json(args.decode_command_json, '--decode-command-json')
        encode_command = _load_command_json(args.encode_command_json, '--encode-command-json')
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
    mib = nbytes / (1024 * 1024)
    if not streaming_io and mib > args.max_pcm_mib:
        raise SystemExit(f'input PCM is {mib:.1f} MiB, above --max-pcm-mib={args.max_pcm_mib:.1f}')
    total_samples = nbytes // input_sample_bytes
    if total_samples % args.channels:
        raise SystemExit('input sample count must be divisible by channels')
    total_frames = total_samples // args.channels
    frames_per_window = max(1, int((args.rate + 5) // 10))
    windows = (total_frames + frames_per_window - 1) // frames_per_window
    seconds = total_frames / float(args.rate)
    measured_values = [args.measured_i, args.measured_lra, args.measured_tp, args.measured_thresh]
    has_measured = all(value is not None and math.isfinite(value) for value in measured_values)
    runtime_offset_db = args.offset_db if args.offset_db is not None and math.isfinite(args.offset_db) else 0.0
    linear_mode = False
    if args.ffmpeg_linear and has_measured:
        linear_offset = args.target_i - args.measured_i
        offset_tp = args.measured_tp + linear_offset
        if (
            args.measured_tp != 99.0
            and args.measured_thresh != -70.0
            and args.measured_lra != 0.0
            and args.measured_i != 0.0
            and offset_tp <= args.target_tp
            and args.measured_lra <= args.target_lra
        ):
            linear_mode = True
            runtime_offset_db = linear_offset
    exact_limiter_requested = args.ffmpeg_limiter and args.input_format == 'f64le' and args.output_format == 'f64le' and has_measured and not linear_mode
    exact_limiter_max_bytes = int(max(0.0, args.ffmpeg_limiter_max_mib) * 1024 * 1024)
    effective_tp = args.target_tp - max(0.0, args.codec_headroom_db)
    limiter_bypass_safe = has_measured and ((args.measured_tp if args.measured_tp is not None else 0.0) + runtime_offset_db) <= (effective_tp + 1e-9)
    parallel_final_apply = exact_limiter_requested and args.parallel_final_apply and limiter_bypass_safe
    exact_limiter_active = exact_limiter_requested and not parallel_final_apply
    exact_stats_stream = exact_limiter_active and env_flag('LOUDNORM_GPU_EXACT_STATS_STREAM')
    exact_prefix_channel_stats = exact_limiter_active and args.input_format == 'f64le' and env_flag('LOUDNORM_GPU_PREFIX_CHANNEL_STATS')
    exact_profile_counts = exact_limiter_active and env_flag('LOUDNORM_GPU_PROFILE_EXACT_COUNTS')
    exact_prefill_output = exact_limiter_active and env_flag('LOUDNORM_GPU_PREFILL_EXACT_OUTPUT', True)
    exact_sparse_chunks = exact_limiter_active and exact_prefill_output and env_flag('LOUDNORM_GPU_SPARSE_CHUNKS', True)
    exact_skip_safe_fill = exact_sparse_chunks and env_flag('LOUDNORM_GPU_SKIP_SAFE_FILL', True)
    exact_skip_safe_feedback = exact_skip_safe_fill and env_flag('LOUDNORM_GPU_SKIP_SAFE_FEEDBACK')
    exact_force_safe_idle = exact_skip_safe_feedback and env_flag('LOUDNORM_GPU_FORCE_SAFE_IDLE')
    ceiling = db_to_amp(effective_tp)
    apply_ceiling = 3.4028234663852886e38 if linear_mode else ceiling
    limiter_lookahead_frames = frame_size(args.rate, 210)
    limiter_alloc_frames = frame_size(args.rate, 3000)
    final_flush_frames = max(0, frames_per_window * 30 - frames_per_window)
    exact_skip_safe_fill_margin_frames = 0 if exact_skip_safe_fill else limiter_lookahead_frames
    if exact_skip_safe_fill:
        try:
            margin_windows = float(os.environ.get('LOUDNORM_GPU_SKIP_SAFE_FILL_MARGIN_WINDOWS', '0'))
            if margin_windows >= 0.0:
                exact_skip_safe_fill_margin_frames = int(margin_windows * frames_per_window)
        except ValueError:
            exact_skip_safe_fill_margin_frames = 0
    exact_risk_expand_windows = 5
    if exact_limiter_active:
        try:
            exact_risk_expand_windows = max(0, int(os.environ.get('LOUDNORM_GPU_RISK_EXPAND_WINDOWS', str(exact_risk_expand_windows))))
        except ValueError:
            exact_risk_expand_windows = 5
    chunk_bytes = int(args.chunk_mib * 1024 * 1024)
    frame_bytes = args.channels * input_sample_bytes
    window_bytes = frames_per_window * frame_bytes
    chunk_bytes = max(window_bytes, chunk_bytes - (chunk_bytes % window_bytes))
    chunk_bytes = min(chunk_bytes, nbytes)
    apply_input_chunk_bytes = chunk_bytes
    if exact_limiter_active:
        apply_input_chunk_bytes = chunk_bytes + (max(limiter_lookahead_frames, final_flush_frames) * frame_bytes)
    output_sample_bytes = 8 if args.output_format == 'f64le' else 4
    output_chunk_bytes = (chunk_bytes // input_sample_bytes) * output_sample_bytes
    return SimpleNamespace(**locals())
