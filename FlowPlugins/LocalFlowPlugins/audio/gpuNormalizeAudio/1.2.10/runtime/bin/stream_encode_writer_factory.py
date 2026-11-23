from runtime_env import env_bytes_mib, env_flag, env_int
from stream_encode_writer import AsyncEncodeWriter


def maybe_async_encode_writer(streaming_io, handle, *, chunk_bytes):
    if getattr(handle, 'loudnorm_null_write', False):
        return handle, None
    if not streaming_io or not env_flag('LOUDNORM_GPU_ASYNC_ENCODE_WRITE', True):
        return handle, None
    max_items = env_int('LOUDNORM_GPU_ASYNC_ENCODE_WRITE_QUEUE', 1024)
    max_bytes = env_bytes_mib('LOUDNORM_GPU_ASYNC_ENCODE_WRITE_MAX_MIB', 1024)
    byte_limited_items = max(1, max_bytes // max(1, chunk_bytes))
    effective_items = min(max_items, byte_limited_items)
    growable_zero_copy = env_flag('LOUDNORM_GPU_GROWABLE_ZERO_COPY_ENCODE_WRITE', False)
    zero_copy = env_flag('LOUDNORM_GPU_ZERO_COPY_ENCODE_WRITE', False) or growable_zero_copy
    pool_items = env_int('LOUDNORM_GPU_ZERO_COPY_ENCODE_WRITE_POOL', min(effective_items, 32)) if zero_copy else None
    if pool_items is not None:
        pool_items = min(effective_items, pool_items)
    writev = env_flag('LOUDNORM_GPU_ASYNC_ENCODE_WRITEV', False)
    writev_max_bytes = env_bytes_mib('LOUDNORM_GPU_ASYNC_ENCODE_WRITEV_MAX_MIB', 8) if writev else 0
    writev_max_items = env_int('LOUDNORM_GPU_ASYNC_ENCODE_WRITEV_MAX_ITEMS', 64) if writev else 0
    writer = AsyncEncodeWriter(
        handle,
        max_items=effective_items,
        zero_copy=zero_copy,
        growable_zero_copy=growable_zero_copy,
        buffer_bytes=chunk_bytes,
        pool_items=pool_items,
        writev=writev,
        writev_max_bytes=writev_max_bytes,
        writev_max_items=writev_max_items,
    )
    return writer, writer
