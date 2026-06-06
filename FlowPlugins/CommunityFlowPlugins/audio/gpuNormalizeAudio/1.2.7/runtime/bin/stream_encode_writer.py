from __future__ import annotations

import ctypes
import os
import queue
import threading
import time

from stream_env import env_bytes_mib, env_flag, env_int


class AsyncEncodeWriter:
    def __init__(self, handle, *, max_items, zero_copy=False, buffer_bytes=0, pool_items=None, writev=False, writev_max_bytes=0, writev_max_items=0):
        self.handle = handle
        self.zero_copy = bool(zero_copy)
        self.writev = bool(writev)
        self.writev_max_bytes = max(1, int(writev_max_bytes)) if self.writev else 0
        self.writev_max_items = max(1, int(writev_max_items)) if self.writev else 0
        self.writev_iov_max = 1024
        if self.writev and hasattr(os, 'sysconf'):
            try:
                self.writev_iov_max = max(1, int(os.sysconf('SC_IOV_MAX')))
            except (OSError, ValueError):
                self.writev_iov_max = 1024
        self.fd = handle.fileno() if self.writev else None
        queue_items = max(1, int(pool_items if pool_items is not None else max_items))
        self.queue = queue.Queue(maxsize=queue_items)
        self.free_buffers = queue.Queue(maxsize=queue_items) if self.zero_copy else None
        if self.zero_copy:
            alloc_bytes = max(1, int(buffer_bytes))
            for _ in range(queue_items):
                buf = bytearray(alloc_bytes)
                ptr = ctypes.addressof(ctypes.c_char.from_buffer(buf))
                self.free_buffers.put((buf, ptr))
        self.closed = False
        self.aborted = False
        self.error = None
        self.worker_write_time = 0.0
        self.close_wait_time = 0.0
        self.peak_queue = 0
        self.borrowed_writes = 0
        self.borrowed_bytes = 0
        self.thread = threading.Thread(target=self._worker, name='async encode writer', daemon=True)
        self.thread.start()

    def _is_borrowed_item(self, item):
        return isinstance(item, tuple) and len(item) == 3 and item[0] == 'borrowed'

    def _release_item(self, item):
        if self._is_borrowed_item(item):
            item[2]()
        elif self.zero_copy:
            self.free_buffers.put(item[0])

    def _item_payload(self, item):
        if self._is_borrowed_item(item):
            return item[1], item[2]
        if self.zero_copy:
            buf_info, size = item
            return memoryview(buf_info[0])[:size], buf_info
        return memoryview(item), None

    def _writev_all(self, payloads):
        views = [payload for payload in payloads if len(payload) > 0]
        while views:
            wrote = os.writev(self.fd, views[:self.writev_iov_max])
            if wrote <= 0:
                raise BrokenPipeError('encode pipe writev wrote no bytes')
            remaining = wrote
            while views and remaining >= len(views[0]):
                remaining -= len(views[0])
                views.pop(0)
            if views and remaining > 0:
                views[0] = views[0][remaining:]

    def _writev_batch(self, first_item):
        batch = [first_item]
        batch_bytes, batch_items = self._item_size(first_item), 1
        stop_after_batch = False
        while batch_items < self.writev_max_items and batch_bytes < self.writev_max_bytes:
            try:
                item = self.queue.get_nowait()
            except queue.Empty:
                break
            if item is None:
                stop_after_batch = True
                break
            if self.aborted:
                self._release_item(item)
                continue
            batch.append(item)
            batch_bytes += self._item_size(item)
            batch_items += 1

        payloads = []
        release_callbacks = []
        try:
            for item in batch:
                payload, release_item = self._item_payload(item)
                payloads.append(payload)
                if release_item is not None:
                    release_callbacks.append(release_item)
            t0 = time.perf_counter()
            self._writev_all(payloads)
            self.worker_write_time += time.perf_counter() - t0
        finally:
            for release_item in release_callbacks:
                if callable(release_item):
                    release_item()
                else:
                    self.free_buffers.put(release_item)
        return stop_after_batch

    def _item_size(self, item):
        if self._is_borrowed_item(item):
            return len(item[1])
        if self.zero_copy:
            return int(item[1])
        return len(item)

    def _worker(self):
        try:
            while True:
                item = self.queue.get()
                if item is None:
                    return
                if self.aborted:
                    self._release_item(item)
                    continue
                if self.writev:
                    if self._writev_batch(item):
                        return
                    continue
                borrowed_release = None
                if self._is_borrowed_item(item):
                    payload = item[1]
                    borrowed_release = item[2]
                elif self.zero_copy:
                    buf_info, size = item
                    payload = memoryview(buf_info[0])[:size]
                else:
                    payload = item
                try:
                    t0 = time.perf_counter()
                    self.handle.write(payload)
                    self.worker_write_time += time.perf_counter() - t0
                finally:
                    if borrowed_release is not None:
                        borrowed_release()
                    elif self.zero_copy:
                        self.free_buffers.put(buf_info)
        except BaseException as exc:
            self.error = exc

    def acquire_buffer(self, size):
        if not self.zero_copy:
            raise RuntimeError('async encode writer is not in zero-copy mode')
        if self.closed:
            raise ValueError('async encode writer is closed')
        buf_info = self.free_buffers.get()
        if len(buf_info[0]) < size:
            self.free_buffers.put(buf_info)
            raise RuntimeError(f'zero-copy encode buffer too small: have={len(buf_info[0])} need={size}')
        return buf_info

    def release_buffer(self, buf_info):
        if self.zero_copy and buf_info is not None:
            self.free_buffers.put(buf_info)

    def write_acquired(self, buf_info, size):
        if self.closed:
            self.release_buffer(buf_info)
            raise ValueError('async encode writer is closed')
        self.queue.put((buf_info, size))
        self.peak_queue = max(self.peak_queue, self.queue.qsize())

    def write_borrowed(self, data, release):
        if self.closed:
            release()
            raise ValueError('async encode writer is closed')
        view = memoryview(data)
        self.queue.put(('borrowed', view, release))
        self.borrowed_writes += 1
        self.borrowed_bytes += len(view)
        self.peak_queue = max(self.peak_queue, self.queue.qsize())

    def write(self, data):
        if self.closed:
            raise ValueError('async encode writer is closed')
        payload = bytes(data)
        self.queue.put(payload)
        self.peak_queue = max(self.peak_queue, self.queue.qsize())

    def close(self):
        if self.closed:
            return
        self.closed = True
        t0 = time.perf_counter()
        self.queue.put(None)
        self.thread.join()
        self.close_wait_time += time.perf_counter() - t0
        try:
            self.handle.close()
        except BrokenPipeError:
            pass
        if self.error is not None:
            raise self.error

    def abort(self):
        self.aborted = True
        if self.closed:
            return
        self.closed = True
        try:
            self.handle.close()
        except BrokenPipeError:
            pass
        try:
            self.queue.put_nowait(None)
        except queue.Full:
            pass
        self.thread.join(timeout=5.0)


def maybe_async_encode_writer(streaming_io, handle, *, chunk_bytes):
    if not streaming_io or not env_flag('LOUDNORM_GPU_ASYNC_ENCODE_WRITE', True):
        return handle, None
    max_items = env_int('LOUDNORM_GPU_ASYNC_ENCODE_WRITE_QUEUE', 1024)
    max_bytes = env_bytes_mib('LOUDNORM_GPU_ASYNC_ENCODE_WRITE_MAX_MIB', 1024)
    byte_limited_items = max(1, max_bytes // max(1, chunk_bytes))
    effective_items = min(max_items, byte_limited_items)
    zero_copy = env_flag('LOUDNORM_GPU_ZERO_COPY_ENCODE_WRITE', False)
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
        buffer_bytes=chunk_bytes,
        pool_items=pool_items,
        writev=writev,
        writev_max_bytes=writev_max_bytes,
        writev_max_items=writev_max_items,
    )
    return writer, writer
