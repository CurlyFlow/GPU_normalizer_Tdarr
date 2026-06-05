from __future__ import annotations

import ctypes

from cuda_driver import alloc_pinned_host_buffer, chk, cuda_event_create, cuda_event_destroy, cuda_event_pair_seconds, has_async_apply_api
from runtime_env import env_flag


class AsyncApplyResources:
    def __init__(self):
        self.ready = False
        self.path = 'sync_pageable'
        self.pinned = 0
        self.stream_count = 0
        self.fallback = 'none'
        self.streams = []
        self.pinned_ptrs = []
        self.pinned_views = []
        self.pinned_raws = []

    def cleanup(self, cuda):
        for stream in self.streams:
            if stream.value:
                cuda.cuStreamDestroy_v2(stream)
        self.streams = []
        for ptr in self.pinned_ptrs:
            if ptr.value:
                cuda.cuMemFreeHost(ptr)
        self.pinned_ptrs = []
        self.pinned_views = []
        self.pinned_raws = []

    def finish_record(self, cuda, record, fo):
        chk(cuda.cuStreamSynchronize(record['stream']), f"cuStreamSynchronize(apply {record['slot']})")
        h2d_time = kernel_time = d2h_time = 0.0
        try:
            for kind, start_event, end_event in record['events']:
                dt = cuda_event_pair_seconds(cuda, start_event, end_event, f'apply {kind}')
                if kind == 'h2d':
                    h2d_time += dt
                elif kind == 'kernel':
                    kernel_time += dt
                elif kind == 'd2h':
                    d2h_time += dt
        finally:
            for _, start_event, end_event in record['events']:
                cuda_event_destroy(cuda, start_event)
                cuda_event_destroy(cuda, end_event)
            record['events'].clear()
        fo.write(record['out_view'][:record['bytes']])
        return h2d_time, kernel_time, d2h_time


def setup_async_apply(cuda, args, buffers, *, chunk_bytes, output_chunk_bytes):
    resources = AsyncApplyResources()
    async_requested = env_flag('LOUDNORM_GPU_ASYNC_APPLY')
    if env_flag('LOUDNORM_GPU_DISABLE_ASYNC_APPLY'):
        resources.fallback = 'disabled_env'
        return resources
    if not async_requested:
        resources.fallback = 'not_requested'
        return resources
    if args.output_format != 'f32le':
        resources.fallback = f'output_format_{args.output_format}'
        return resources
    if not has_async_apply_api(cuda):
        resources.fallback = 'missing_async_api'
        return resources

    try:
        chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_apply_in_b), chunk_bytes), 'cuMemAlloc(apply input b)')
        chk(cuda.cuMemAlloc_v2(ctypes.byref(buffers.d_apply_out_b), output_chunk_bytes), 'cuMemAlloc(apply output b)')
        for slot in range(2):
            stream = ctypes.c_void_p()
            chk(cuda.cuStreamCreate(ctypes.byref(stream), 0), f'cuStreamCreate(apply {slot})')
            resources.streams.append(stream)
            in_ptr, in_raw, in_view = alloc_pinned_host_buffer(cuda, chunk_bytes, f'apply input {slot}')
            out_ptr, out_raw, out_view = alloc_pinned_host_buffer(cuda, chunk_bytes, f'apply output {slot}')
            resources.pinned_ptrs.extend([in_ptr, out_ptr])
            resources.pinned_raws.extend([in_raw, out_raw])
            resources.pinned_views.extend([in_view, out_view])
        probe_event = cuda_event_create(cuda, 'apply async probe')
        cuda_event_destroy(cuda, probe_event)
        resources.ready = True
        resources.path = 'async_pinned_double'
        resources.pinned = 1
        resources.stream_count = 2
    except Exception as exc:
        resources.fallback = exc.__class__.__name__
        resources.cleanup(cuda)
    return resources
