from __future__ import annotations

import array
import ctypes
import json

from cuda_driver import chk
from stats_passes import StatsPassResult


MAGIC = 'loudnorm-gpu-stats-cache-v1'


def _copy_device_array(cuda, ptr, typecode, count, label):
    values = array.array(typecode, [0]) * count
    if count:
        chk(cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(values.buffer_info()[0]), ptr, values.itemsize * count), f'cuMemcpyDtoH({label})')
    return values


def _write_array(fh, values):
    values.tofile(fh)


def _read_array(fh, typecode, count, label):
    values = array.array(typecode)
    values.fromfile(fh, count)
    if len(values) != count:
        raise RuntimeError(f'short stats cache read for {label}')
    return values


def dump_stats_cache(path, cuda, args, cfg, buffers, stats_result):
    windows = stats_result.windows
    state_doubles = stats_result.state_bytes // 8
    source_exact_doubles = windows * 3 if cfg.source_exact_precompute else 0
    header = {
        'magic': MAGIC,
        'rate': args.rate,
        'channels': args.channels,
        'input_format': args.input_format,
        'output_format': args.output_format,
        'nbytes': stats_result.nbytes,
        'mib': stats_result.mib,
        'total_samples': stats_result.total_samples,
        'total_frames': stats_result.total_frames,
        'windows': windows,
        'seconds': stats_result.seconds,
        'state_bytes': stats_result.state_bytes,
        'source_exact_precompute': 1 if cfg.source_exact_precompute else 0,
        'source_exact_doubles': source_exact_doubles,
    }
    sums = _copy_device_array(cuda, buffers.d_sums, 'd', windows, 'stats cache sums')
    peaks = _copy_device_array(cuda, buffers.d_peaks, 'I', windows, 'stats cache peaks')
    start_states = _copy_device_array(cuda, buffers.d_start_states, 'd', state_doubles, 'stats cache start_states')
    source_exact_sums = array.array('d')
    if source_exact_doubles:
        source_exact_sums = _copy_device_array(cuda, buffers.d_source_exact_sums, 'd', source_exact_doubles, 'stats cache source_exact_sums')
    with open(path, 'wb') as fh:
        fh.write((json.dumps(header, separators=(',', ':')) + '\n').encode('utf-8'))
        _write_array(fh, sums)
        _write_array(fh, peaks)
        _write_array(fh, start_states)
        if source_exact_doubles:
            _write_array(fh, source_exact_sums)


def load_stats_cache(path, cuda, args, cfg, buffers):
    with open(path, 'rb') as fh:
        header = json.loads(fh.readline().decode('utf-8'))
        if header.get('magic') != MAGIC:
            raise RuntimeError('invalid stats cache magic')
        for key, expected in (
            ('rate', args.rate),
            ('channels', args.channels),
            ('input_format', args.input_format),
            ('output_format', args.output_format),
        ):
            if header.get(key) != expected:
                raise RuntimeError(f'stats cache {key} mismatch: cache={header.get(key)} runtime={expected}')
        windows = int(header['windows'])
        state_bytes = int(header['state_bytes'])
        if windows > cfg.windows:
            raise RuntimeError(f'stats cache windows exceed runtime allocation: cache={windows} runtime={cfg.windows}')
        state_capacity_bytes = cfg.windows * args.channels * 4 * 8
        if state_bytes > state_capacity_bytes:
            raise RuntimeError(f'stats cache state exceeds runtime allocation: cache={state_bytes} runtime={state_capacity_bytes}')
        cache_source_exact = bool(header.get('source_exact_precompute'))
        if cfg.source_exact_precompute and not cache_source_exact:
            raise RuntimeError('stats cache source_exact_precompute mismatch')
        sums = _read_array(fh, 'd', windows, 'sums')
        peaks = _read_array(fh, 'I', windows, 'peaks')
        start_states = _read_array(fh, 'd', state_bytes // 8, 'start_states')
        source_exact_sums = array.array('d')
        source_exact_doubles = int(header.get('source_exact_doubles', 0))
        if source_exact_doubles:
            source_exact_sums = _read_array(fh, 'd', source_exact_doubles, 'source_exact_sums')

    chk(cuda.cuMemcpyHtoD_v2(buffers.d_sums, ctypes.c_void_p(sums.buffer_info()[0]), sums.itemsize * len(sums)), 'cuMemcpyHtoD(stats cache sums)')
    chk(cuda.cuMemcpyHtoD_v2(buffers.d_peaks, ctypes.c_void_p(peaks.buffer_info()[0]), peaks.itemsize * len(peaks)), 'cuMemcpyHtoD(stats cache peaks)')
    chk(cuda.cuMemcpyHtoD_v2(buffers.d_start_states, ctypes.c_void_p(start_states.buffer_info()[0]), start_states.itemsize * len(start_states)), 'cuMemcpyHtoD(stats cache start_states)')
    if cfg.source_exact_precompute and source_exact_doubles:
        chk(cuda.cuMemcpyHtoD_v2(buffers.d_source_exact_sums, ctypes.c_void_p(source_exact_sums.buffer_info()[0]), source_exact_sums.itemsize * len(source_exact_sums)), 'cuMemcpyHtoD(stats cache source_exact_sums)')

    return StatsPassResult(
        nbytes=int(header['nbytes']),
        mib=float(header['mib']),
        total_samples=int(header['total_samples']),
        total_frames=int(header['total_frames']),
        windows=windows,
        seconds=float(header['seconds']),
        state_bytes=state_bytes,
    )
