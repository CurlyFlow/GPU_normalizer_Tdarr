from __future__ import annotations

import ctypes
import time


def load_cuda():
    cuda = ctypes.CDLL('libcuda.so.1')
    cuda.cuInit.argtypes = [ctypes.c_uint]
    cuda.cuDeviceGet.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_int]
    cuda.cuDeviceGetName.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_int]
    cuda.cuCtxCreate_v2.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_uint, ctypes.c_int]
    cuda.cuCtxDestroy_v2.argtypes = [ctypes.c_void_p]
    cuda.cuCtxSynchronize.argtypes = []
    cuda.cuModuleLoadData.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    cuda.cuModuleLoadDataEx.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.c_uint, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_void_p)]
    cuda.cuModuleGetFunction.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.c_char_p]
    cuda.cuModuleUnload.argtypes = [ctypes.c_void_p]
    cuda.cuMemAlloc_v2.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_size_t]
    cuda.cuMemFree_v2.argtypes = [ctypes.c_void_p]
    cuda.cuMemsetD32_v2.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t]
    cuda.cuMemcpyHtoD_v2.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
    cuda.cuMemcpyDtoH_v2.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
    cuda.cuMemcpyDtoD_v2.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
    try:
        cuda.cuMemHostAlloc.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_size_t, ctypes.c_uint]
        cuda.cuMemFreeHost.argtypes = [ctypes.c_void_p]
        cuda.cuMemcpyHtoDAsync_v2.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
        cuda.cuMemcpyDtoHAsync_v2.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
        cuda.cuStreamCreate.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_uint]
        cuda.cuStreamSynchronize.argtypes = [ctypes.c_void_p]
        cuda.cuStreamDestroy_v2.argtypes = [ctypes.c_void_p]
        cuda._has_async_apply_api = True
    except AttributeError:
        cuda._has_async_apply_api = False
    cuda.cuEventCreate.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_uint]
    cuda.cuEventRecord.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    cuda.cuEventSynchronize.argtypes = [ctypes.c_void_p]
    cuda.cuEventElapsedTime.argtypes = [ctypes.POINTER(ctypes.c_float), ctypes.c_void_p, ctypes.c_void_p]
    cuda.cuEventDestroy_v2.argtypes = [ctypes.c_void_p]
    cuda.cuLaunchKernel.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint, ctypes.c_uint, ctypes.c_uint,
        ctypes.c_uint, ctypes.c_uint, ctypes.c_uint,
        ctypes.c_uint,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    return cuda


def has_async_apply_api(cuda):
    return bool(getattr(cuda, '_has_async_apply_api', False))


def chk(rc, label):
    if rc != 0:
        raise RuntimeError(f'{label} failed: CUDA error {rc}')


def ptr_arg(value):
    return ctypes.cast(ctypes.byref(value), ctypes.c_void_p)


def cuda_event_elapsed(cuda, label, launch):
    start = ctypes.c_void_p()
    end = ctypes.c_void_p()
    if cuda.cuEventCreate(ctypes.byref(start), 0) != 0:
        t0 = time.perf_counter()
        launch()
        chk(cuda.cuCtxSynchronize(), f'cuCtxSynchronize({label})')
        return time.perf_counter() - t0
    try:
        chk(cuda.cuEventCreate(ctypes.byref(end), 0), f'cuEventCreate({label} end)')
        chk(cuda.cuEventRecord(start, None), f'cuEventRecord({label} start)')
        launch()
        chk(cuda.cuEventRecord(end, None), f'cuEventRecord({label} end)')
        chk(cuda.cuEventSynchronize(end), f'cuEventSynchronize({label})')
        elapsed_ms = ctypes.c_float()
        chk(cuda.cuEventElapsedTime(ctypes.byref(elapsed_ms), start, end), f'cuEventElapsedTime({label})')
        return float(elapsed_ms.value) / 1000.0
    finally:
        if end.value:
            cuda.cuEventDestroy_v2(end)
        if start.value:
            cuda.cuEventDestroy_v2(start)


def cuda_event_create(cuda, label):
    event = ctypes.c_void_p()
    chk(cuda.cuEventCreate(ctypes.byref(event), 0), f'cuEventCreate({label})')
    return event


def cuda_event_pair_seconds(cuda, start, end, label):
    elapsed_ms = ctypes.c_float()
    chk(cuda.cuEventElapsedTime(ctypes.byref(elapsed_ms), start, end), f'cuEventElapsedTime({label})')
    return float(elapsed_ms.value) / 1000.0


def cuda_event_destroy(cuda, event):
    if event is not None and event.value:
        cuda.cuEventDestroy_v2(event)


def alloc_pinned_host_buffer(cuda, size, label):
    ptr = ctypes.c_void_p()
    chk(cuda.cuMemHostAlloc(ctypes.byref(ptr), size, 0), f'cuMemHostAlloc({label})')
    raw = (ctypes.c_ubyte * size).from_address(ptr.value)
    return ptr, raw, memoryview(raw).cast('B')


def load_module(cuda, ptx):
    module = ctypes.c_void_p()
    rc = cuda.cuModuleLoadData(ctypes.byref(module), ctypes.c_char_p(ptx.encode()))
    if rc != 0:
        raise RuntimeError(f'cuModuleLoadData failed: CUDA error {rc}')
    return module
