import json
from pathlib import Path
import sys

from feedback_apply import (
    FB_D_DELTA,
    FB_D_OUT_SHORT_RING,
    FB_D_OUT_STATES,
    FB_D_SHORT_RING,
    FB_D_SOURCE_OUT_SHORT_RING0,
    FB_D_SOURCE_OUT_SHORT_RING1,
    FB_D_SOURCE_IN_STATE0,
    FB_D_SOURCE_IN_STATE1,
    FEEDBACK_PROFILE_COUNT_FIELDS,
    FEEDBACK_STATE_D_FIELDS,
    FEEDBACK_STATE_I_FIELDS,
    FFMPEG_STATE_AUDIT_D_WORDS,
    FFMPEG_STATE_AUDIT_I_WORDS,
)
from loudnorm_math import frame_size
from runtime_env import env_flag, env_string


_FRAME_TYPE_NAMES = {
    0: 'first',
    1: 'inner',
    2: 'final',
}

_LIMITER_STATE_NAMES = {
    0: 'out',
    1: 'attack',
    2: 'sustain',
    3: 'release',
}

_SNAPSHOT_EVENT_NAMES = {
    1: 'cuda_init_3s',
    2: 'limiter_before',
    3: 'limiter_after',
    4: 'delta_after',
    5: 'final_flush_start',
    6: 'final_flush_end',
}


def _maybe_number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _output_frames(apply_result, fallback_frames):
    counts = getattr(apply_result, 'exact_counts_host', None)
    if counts is None or len(counts) <= 116:
        return fallback_frames
    return _maybe_number(counts[116]) or fallback_frames


def _runtime_role(args):
    if getattr(args, 'stats_cache_only', False):
        return 'stats'
    if getattr(args, 'emit_first_pass_input_json', False):
        return 'first_pass_input'
    if getattr(args, 'emit_first_pass_json', False):
        return 'first_pass_apply'
    return 'apply'


def _fields_from_array(values, mapping):
    return {name: values[index] for name, index in mapping.items() if index < len(values)}


def _slice(values, start, length):
    end = min(len(values), start + length)
    if start >= end:
        return []
    return list(values[start:end])


def _ffmpeg_timing(args, cfg):
    return {
        'frame_100ms': frame_size(args.rate, 100),
        'frame_3000ms': frame_size(args.rate, 3000),
        'limiter_lookahead_frames': cfg.limiter.limiter_lookahead_frames,
        'final_flush_frames': cfg.limiter.final_flush_frames,
    }


def _append_event(path, event):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a', encoding='utf-8') as fh:
        fh.write(json.dumps(event, sort_keys=True, allow_nan=True))
        fh.write('\n')


def _cuda_final_state_event(args, cfg, apply_result):
    state_i = getattr(apply_result, 'ffmpeg_state_audit_i_host', None)
    state_d = getattr(apply_result, 'ffmpeg_state_audit_d_host', None)
    if state_i is None or state_d is None:
        return None

    state_i_values = list(state_i)
    state_d_values = list(state_d)
    decoded_i = _fields_from_array(state_i_values, FEEDBACK_STATE_I_FIELDS)
    decoded_d = _fields_from_array(state_d_values, FEEDBACK_STATE_D_FIELDS)
    frame_type_code = decoded_i.get('frame_type')
    limiter_state_code = decoded_i.get('limiter_state')
    return {
        'schema': 'opx.ffmpeg_state_audit.v1',
        'event': 'cuda_final_state',
        'source': 'cuda_runtime',
        'role': _runtime_role(args),
        'frame': decoded_i.get('out_frame', 0),
        'frames': cfg.input_shape.total_frames,
        'frame_type': _FRAME_TYPE_NAMES.get(frame_type_code, frame_type_code),
        'rate': args.rate,
        'channels': args.channels,
        'ffmpeg_timing': _ffmpeg_timing(args, cfg),
        'r128_in': {},
        'r128_out': {},
        'dynamic': {
            'index': decoded_i.get('delta_index'),
            'prev_delta': decoded_d.get('prev_delta'),
            'above_threshold': decoded_i.get('above_threshold'),
            'input_window': decoded_i.get('input_window'),
            'short_index': decoded_i.get('short_index'),
            'short_count': decoded_i.get('short_count'),
            'short_sum': decoded_d.get('short_sum'),
            'delta': _slice(state_d_values, FB_D_DELTA, 30),
        },
        'limiter': {
            'state': _LIMITER_STATE_NAMES.get(limiter_state_code, limiter_state_code),
            'state_code': limiter_state_code,
            'peak_index': decoded_i.get('peak_index'),
            'env_index': decoded_i.get('env_index'),
            'env_cnt': decoded_i.get('env_cnt'),
            'attack_state': decoded_i.get('attack_state'),
            'maybe_above_ceiling': decoded_i.get('limiter_maybe_above_ceiling'),
            'gain_reduction0': decoded_d.get('gain_reduction0'),
            'gain_reduction1': decoded_d.get('gain_reduction1'),
            'ceiling': cfg.limiter.ceiling,
            'apply_ceiling': cfg.limiter.apply_ceiling,
        },
        'output_feedback': {
            'out_frame': decoded_i.get('out_frame'),
            'write_frame': decoded_i.get('write_frame'),
            'write_index': decoded_i.get('write_index'),
            'out_short_index': decoded_i.get('out_short_index'),
            'out_short_count': decoded_i.get('out_short_count'),
            'out_window_count': decoded_i.get('out_window_count'),
            'out_short_sum': decoded_d.get('out_short_sum'),
            'out_window_sum': decoded_d.get('out_window_sum'),
            'out_short_ring': _slice(state_d_values, FB_D_OUT_SHORT_RING, 30),
            'out_states': _slice(state_d_values, FB_D_OUT_STATES, 20),
        },
        'source_feedback': {
            'short_ring': _slice(state_d_values, FB_D_SHORT_RING, 30),
            'source_out_short_ring0': _slice(state_d_values, FB_D_SOURCE_OUT_SHORT_RING0, 30),
            'source_out_short_ring1': _slice(state_d_values, FB_D_SOURCE_OUT_SHORT_RING1, 30),
            'source_in_state0': _slice(state_d_values, FB_D_SOURCE_IN_STATE0, 4),
            'source_in_state1': _slice(state_d_values, FB_D_SOURCE_IN_STATE1, 4),
            'source_out_window_sum0': decoded_d.get('source_out_window_sum0'),
            'source_out_window_sum1': decoded_d.get('source_out_window_sum1'),
        },
        'flags': decoded_i,
        'profile_counts': _fields_from_array(state_d_values, FEEDBACK_PROFILE_COUNT_FIELDS),
        'raw': {
            'state_i': state_i_values,
            'state_d': state_d_values,
        },
        'output_frames': _output_frames(apply_result, cfg.input_shape.total_frames),
    }


def _cuda_snapshot_events(args, cfg, apply_result):
    audit_i = getattr(apply_result, 'ffmpeg_state_audit_snapshot_i_host', None)
    audit_d = getattr(apply_result, 'ffmpeg_state_audit_snapshot_d_host', None)
    count = int(getattr(apply_result, 'ffmpeg_state_audit_snapshot_count', 0) or 0)
    if audit_i is None or audit_d is None or count <= 0:
        return []

    events = []
    for record_index in range(count):
        i_base = 1 + record_index * FFMPEG_STATE_AUDIT_I_WORDS
        d_base = record_index * FFMPEG_STATE_AUDIT_D_WORDS
        i_record = list(audit_i[i_base:i_base + FFMPEG_STATE_AUDIT_I_WORDS])
        d_record = list(audit_d[d_base:d_base + FFMPEG_STATE_AUDIT_D_WORDS])
        if len(i_record) < FFMPEG_STATE_AUDIT_I_WORDS or len(d_record) < FFMPEG_STATE_AUDIT_D_WORDS:
            break
        event_code = i_record[0]
        frame_type_code = i_record[1]
        limiter_state_code = i_record[16]
        events.append({
            'schema': 'opx.ffmpeg_state_audit.v1',
            'event': _SNAPSHOT_EVENT_NAMES.get(event_code, f'cuda_event_{event_code}'),
            'event_code': event_code,
            'source': 'cuda_runtime',
            'role': _runtime_role(args),
            'record_index': record_index,
            'frame': i_record[2],
            'frames': i_record[3],
            'frame_type': _FRAME_TYPE_NAMES.get(frame_type_code, frame_type_code),
            'rate': args.rate,
            'channels': args.channels,
            'ffmpeg_timing': _ffmpeg_timing(args, cfg),
            'r128_in': {},
            'r128_out': {},
            'dynamic': {
                'input_window': i_record[5],
                'index': i_record[14],
                'above_threshold': i_record[15],
                'short_index': i_record[9],
                'short_count': i_record[10],
                'short_sum': d_record[0],
                'prev_delta': d_record[3],
                'delta': d_record[8:38],
            },
            'limiter': {
                'state': _LIMITER_STATE_NAMES.get(limiter_state_code, limiter_state_code),
                'state_code': limiter_state_code,
                'peak_index': i_record[17],
                'env_index': i_record[18],
                'env_cnt': i_record[19],
                'attack_state': i_record[20],
                'maybe_above_ceiling': i_record[24],
                'gain_reduction0': d_record[4],
                'gain_reduction1': d_record[5],
                'ceiling': cfg.limiter.ceiling,
                'apply_ceiling': cfg.limiter.apply_ceiling,
            },
            'output_feedback': {
                'out_frame': i_record[6],
                'write_frame': i_record[7],
                'write_index': i_record[8],
                'out_short_index': i_record[11],
                'out_short_count': i_record[12],
                'out_window_count': i_record[13],
                'out_short_sum': d_record[1],
                'out_window_sum': d_record[2],
            },
            'source_feedback': {
                'source_out_window_sum0': d_record[6],
                'source_out_window_sum1': d_record[7],
            },
            'flags': {
                'first': i_record[21],
                'final_initialized': i_record[22],
                'final_src_offset': i_record[23],
            },
            'raw': {
                'record_i': i_record,
                'record_d': d_record,
            },
            'output_frames': i_record[4],
        })
    return events


def _audit_path():
    if not env_flag('LOUDNORM_GPU_AUDIT_FFMPEG_STATE'):
        return None
    value = env_string('LOUDNORM_GPU_AUDIT_FFMPEG_STATE_PATH', '', strip=True)
    if not value:
        print('ffmpeg_state_audit skipped: LOUDNORM_GPU_AUDIT_FFMPEG_STATE_PATH is empty', file=sys.stderr)
        return None
    return Path(value)


def emit_ffmpeg_state_audit(args, cfg, *, gain_metrics, apply_result):
    path = _audit_path()
    if path is None:
        return

    event = {
        'schema': 'opx.ffmpeg_state_audit.v1',
        'event': 'runtime_summary',
        'source': 'cuda_runtime',
        'role': _runtime_role(args),
        'frame': 0,
        'frames': cfg.input_shape.total_frames,
        'frame_type': 'linear' if cfg.loudnorm_mode.linear_mode else 'dynamic',
        'rate': args.rate,
        'channels': args.channels,
        'targets': {
            'i': args.target_i,
            'lra': args.target_lra,
            'tp': args.target_tp,
            'effective_tp': cfg.loudnorm_mode.effective_tp,
            'max_gain_db': args.max_gain_db,
        },
        'measured': {
            'i': args.measured_i,
            'lra': args.measured_lra,
            'tp': args.measured_tp,
            'thresh': args.measured_thresh,
            'offset_db': cfg.loudnorm_mode.runtime_offset_db,
        },
        'ffmpeg_timing': _ffmpeg_timing(args, cfg),
        'r128_in': {},
        'r128_out': {},
        'dynamic': {
            'linear_mode': cfg.loudnorm_mode.linear_mode,
            'exact_limiter_active': cfg.loudnorm_mode.exact_limiter_active,
            'audit_snapshots': getattr(cfg.exact, 'audit_ffmpeg_state_snapshots', False),
            'audit_force_direct': getattr(cfg.exact, 'audit_ffmpeg_state_force_direct', False),
            'audit_sample_windows': getattr(cfg.exact, 'audit_ffmpeg_state_sample_windows', None),
            'audit_max_events': getattr(cfg.exact, 'audit_ffmpeg_state_max_events', None),
            'gain_min_amp': getattr(gain_metrics, 'gain_min_amp', None),
            'gain_max_amp': getattr(gain_metrics, 'gain_max_amp', None),
        },
        'limiter': {
            'requested': cfg.loudnorm_mode.exact_limiter_requested,
            'active': cfg.loudnorm_mode.exact_limiter_active,
            'ceiling': cfg.limiter.ceiling,
            'apply_ceiling': cfg.limiter.apply_ceiling,
        },
        'output_frames': _output_frames(apply_result, cfg.input_shape.total_frames),
    }

    _append_event(path, event)
    print(f'ffmpeg_state_audit path={path} event=runtime_summary', file=sys.stderr)

    snapshot_events = _cuda_snapshot_events(args, cfg, apply_result)
    for snapshot_event in snapshot_events:
        _append_event(path, snapshot_event)
    if snapshot_events:
        print(f'ffmpeg_state_audit path={path} event=cuda_state_snapshot count={len(snapshot_events)}', file=sys.stderr)

    final_state_event = _cuda_final_state_event(args, cfg, apply_result)
    if final_state_event is not None:
        _append_event(path, final_state_event)
        print(f'ffmpeg_state_audit path={path} event=cuda_final_state', file=sys.stderr)
