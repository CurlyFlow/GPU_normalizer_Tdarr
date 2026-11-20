from __future__ import annotations

import ctypes
import time

from cuda_driver import alloc_pinned_host_buffer, chk
from cuda_launch import launch_kernel, launch_timed_kernel
from stats_channel_plan import build_channel_chunk_plan
from stats_channel_source import ChannelSourceStage
from stats_q_sums import combine_channel_sums


class ChannelStatsExecution:
    def __init__(self, ctx, result, mode):
        self.ctx = ctx
        self.result = result
        self.mode = mode
        self.source_stage = ChannelSourceStage.create(ctx, result, mode.source_stage_config, self.sync_async_stats)
        self.peak_stream = ctypes.c_void_p()
        self.channel_stream = ctypes.c_void_p()
        self.stats_streams = []
        self.stats_peak_streams = []
        self.stats_h2d_events = []
        self.stats_pending = []
        self.stats_peak_pending = []
        self.stats_host_buffers = []
        self.stats_host_ptrs = []
        self.stats_pinned_ptrs = []
        self.stats_pinned_raws = []
        self.stats_prefetch_buffers = []
        self.stats_payload_releasers = [None, None]
        self.last_stats_stream_idx = None

    def __enter__(self):
        self._open_streams()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False

    def frame_reader_options(self):
        return {
            'direct_payload': self.mode.direct_stats_bytes_payload,
            'direct_bytearray_payload': self.mode.direct_stats_bytearray_payload,
            'direct_payload_buffers': self.stats_prefetch_buffers if self.mode.use_direct_pinned_prefetch else None,
            'auto_return_payload': not self.mode.use_direct_pinned_prefetch,
        }

    def close(self):
        self.sync_async_stats('stats async cleanup')
        if self.channel_stream.value:
            self.ctx.cuda.cuStreamDestroy_v2(self.channel_stream)
        if self.peak_stream.value:
            self.ctx.cuda.cuStreamDestroy_v2(self.peak_stream)
        for stream in self.stats_streams:
            if stream.value:
                self.ctx.cuda.cuStreamDestroy_v2(stream)
        for stream in self.stats_peak_streams:
            if stream.value:
                self.ctx.cuda.cuStreamDestroy_v2(stream)
        for event in self.stats_h2d_events:
            if event.value:
                self.ctx.cuda.cuEventDestroy_v2(event)
        for ptr in self.stats_pinned_ptrs:
            if ptr.value:
                self.ctx.cuda.cuMemFreeHost(ptr)

    def release_stats_payload(self, idx):
        if idx < len(self.stats_pending) and self.stats_pending[idx]:
            return
        if idx < len(self.stats_peak_pending) and self.stats_peak_pending[idx]:
            return
        releaser = self.stats_payload_releasers[idx]
        if releaser is None:
            return
        releaser()
        self.stats_payload_releasers[idx] = None

    def sync_async_peak(self, idx, label):
        if not self.mode.use_async_parallel_peaks or not self.stats_peak_pending[idx]:
            return
        sync_t0 = time.perf_counter()
        chk(self.ctx.cuda.cuStreamSynchronize(self.stats_peak_streams[idx]), f'cuStreamSynchronize({label} peak {idx})')
        self.result.stats_sums_wall_time += time.perf_counter() - sync_t0
        self.stats_peak_pending[idx] = False

    def sync_async_stats(self, label):
        if not self.mode.use_async_pipeline:
            return
        for idx, stream in enumerate(self.stats_streams):
            if not self.stats_pending[idx] and not (self.mode.use_async_parallel_peaks and self.stats_peak_pending[idx]):
                continue
            if self.stats_pending[idx]:
                sync_t0 = time.perf_counter()
                chk(self.ctx.cuda.cuStreamSynchronize(stream), f'cuStreamSynchronize({label} {idx})')
                self.result.stats_sums_wall_time += time.perf_counter() - sync_t0
                self.stats_pending[idx] = False
            self.sync_async_peak(idx, label)
            self.release_stats_payload(idx)

    def process_chunk(self, chunk, chunk_index, done_bytes):
        async_slot = chunk_index & 1
        self._sync_reused_async_slot(async_slot)
        plan = self._build_chunk_plan(chunk, async_slot)
        stage_t0 = time.perf_counter()
        copy_dt = self._copy_chunk_to_device(chunk, async_slot, plan)
        kernel_dt = self._launch_chunk_kernels(async_slot, plan)
        self.result.stats_sums_h2d_time += copy_dt
        self.result.total_h2d_time += copy_dt
        self.result.stats_sums_kernel_time += kernel_dt
        self.result.stats_sums_wall_time += time.perf_counter() - stage_t0
        chunk_view = plan.chunk_view
        if chunk_view is None:
            chunk_view = memoryview(self.ctx.host_io.host_in)[:chunk.this_bytes]
        self.source_stage.process_after_chunk(chunk, chunk_view, done_bytes)
        self.ctx.emit_progress('stats_sums', 0.70 * (done_bytes / float(self.ctx.cfg.input_shape.nbytes)))

    def finish(self, done_bytes):
        self.sync_async_stats('stats async final')
        self.source_stage.finish(done_bytes)
        combine_channel_sums(self.ctx, self.result, source_arg=self.ctx.bindings.start_states_arg, label='combine-channel-sums')
        self.source_stage.audit_ffmpeg_input_metrics()
        self.ctx.emit_progress('stats_sums', 0.70)

    def _open_streams(self):
        cfg = self.ctx.cfg
        if self.mode.use_parallel_peaks:
            chk(self.ctx.cuda.cuStreamCreate(ctypes.byref(self.peak_stream), 0), 'cuStreamCreate(stats peaks)')
            chk(self.ctx.cuda.cuStreamCreate(ctypes.byref(self.channel_stream), 0), 'cuStreamCreate(stats channel)')
        elif self.mode.use_async_pipeline:
            stats_pinned_bytes = max(1, int(getattr(cfg.sizing, 'stats_chunk_bytes', len(self.ctx.host_io.host_in)))) if self.mode.use_direct_pinned_prefetch else len(self.ctx.host_io.host_in)
            for idx in range(2):
                stream = ctypes.c_void_p()
                chk(self.ctx.cuda.cuStreamCreate(ctypes.byref(stream), 0), f'cuStreamCreate(stats async {idx})')
                self.stats_streams.append(stream)
                self.stats_pending.append(False)
                if self.mode.use_async_parallel_peaks:
                    peak = ctypes.c_void_p()
                    event = ctypes.c_void_p()
                    chk(self.ctx.cuda.cuStreamCreate(ctypes.byref(peak), 0), f'cuStreamCreate(stats async peak {idx})')
                    chk(self.ctx.cuda.cuEventCreate(ctypes.byref(event), 0), f'cuEventCreate(stats async h2d {idx})')
                    self.stats_peak_streams.append(peak)
                    self.stats_h2d_events.append(event)
                    self.stats_peak_pending.append(False)
                if self.mode.use_pinned_async_pipeline:
                    ptr, raw, view = alloc_pinned_host_buffer(self.ctx.cuda, stats_pinned_bytes, f'stats async input {idx}')
                    self.stats_pinned_ptrs.append(ptr)
                    self.stats_pinned_raws.append(raw)
                    self.stats_host_buffers.append(view)
                    self.stats_host_ptrs.append(ptr.value)
                    if self.mode.use_direct_pinned_prefetch:
                        self.stats_prefetch_buffers.append((view, ptr.value))
                else:
                    stage_buffer = bytearray(stats_pinned_bytes)
                    self.stats_host_buffers.append(stage_buffer)
                    self.stats_host_ptrs.append(ctypes.addressof(ctypes.c_char.from_buffer(stage_buffer)))
            if self.mode.use_direct_pinned_prefetch:
                target_prefetch_buffers = max(3, int(getattr(cfg.exact, 'stats_prefetch_pinned_async_buffers', 2)))
                for idx in range(len(self.stats_prefetch_buffers), target_prefetch_buffers):
                    ptr, raw, view = alloc_pinned_host_buffer(self.ctx.cuda, stats_pinned_bytes, f'stats async prefetch input {idx}')
                    self.stats_pinned_ptrs.append(ptr)
                    self.stats_pinned_raws.append(raw)
                    self.stats_prefetch_buffers.append((view, ptr.value))

    def _sync_reused_async_slot(self, async_slot):
        if not self.mode.use_async_pipeline:
            return
        if not (self.stats_pending[async_slot] or (self.mode.use_async_parallel_peaks and self.stats_peak_pending[async_slot])):
            return
        if self.stats_pending[async_slot]:
            sync_t0 = time.perf_counter()
            chk(self.ctx.cuda.cuStreamSynchronize(self.stats_streams[async_slot]), f'cuStreamSynchronize(stats async reuse {async_slot})')
            self.result.stats_sums_wall_time += time.perf_counter() - sync_t0
            self.stats_pending[async_slot] = False
        self.sync_async_peak(async_slot, 'stats async reuse')
        self.release_stats_payload(async_slot)

    def _build_chunk_plan(self, chunk, async_slot):
        return build_channel_chunk_plan(self.ctx, self.mode, self.source_stage, chunk, async_slot)

    def _copy_chunk_to_device(self, chunk, async_slot, plan):
        t0 = time.perf_counter()
        if self.mode.use_async_pipeline:
            stream = self.stats_streams[async_slot]
            if self.mode.use_direct_pinned_prefetch and getattr(chunk, 'payload_ptr', 0):
                self.stats_payload_releasers[async_slot] = chunk.payload_releaser
                h2d_input_ptr = chunk.payload_ptr
            else:
                memoryview(self.stats_host_buffers[async_slot])[:chunk.this_bytes] = memoryview(self.ctx.host_io.host_in)[:chunk.this_bytes]
                h2d_input_ptr = self.stats_host_ptrs[async_slot]
            chk(self.ctx.cuda.cuMemcpyHtoDAsync_v2(plan.input_ptr, ctypes.c_void_p(h2d_input_ptr), chunk.this_bytes, stream), 'cuMemcpyHtoDAsync(channel stats input)')
        else:
            chk(self.ctx.cuda.cuMemcpyHtoD_v2(plan.input_ptr, ctypes.c_void_p(plan.chunk_input_ptr), chunk.this_bytes), 'cuMemcpyHtoD(channel stats input)')
        return time.perf_counter() - t0

    def _launch_chunk_kernels(self, async_slot, plan):
        if self.mode.use_parallel_peaks:
            return self._launch_parallel_peaks(plan)
        if self.mode.use_async_pipeline:
            return self._launch_async_pipeline(async_slot, plan)
        if self.ctx.cfg.exact.exact_stats_fast_launch:
            return self._launch_fast(plan)
        return self._launch_timed(plan)

    def _launch_parallel_peaks(self, plan):
        kernel_t0 = time.perf_counter()
        chk(self.ctx.cuda.cuLaunchKernel(self.ctx.kernels.peak_fn, plan.peak_grid, 1, 1, 256, 1, 1, 0, self.peak_stream, plan.peak_args, None), 'cuLaunchKernel(window-peaks parallel)')
        chk(self.ctx.cuda.cuLaunchKernel(plan.channel_kernel_fn, self.mode.channel_grid_x, 1, 1, self.mode.channel_block_x, 1, 1, 0, self.channel_stream, plan.channel_args, None), 'cuLaunchKernel(channel-stats parallel)')
        chk(self.ctx.cuda.cuStreamSynchronize(self.peak_stream), 'cuStreamSynchronize(stats peaks)')
        chk(self.ctx.cuda.cuStreamSynchronize(self.channel_stream), 'cuStreamSynchronize(stats channel)')
        return time.perf_counter() - kernel_t0

    def _launch_async_pipeline(self, async_slot, plan):
        kernel_t0 = time.perf_counter()
        if self.last_stats_stream_idx is not None and self.stats_pending[self.last_stats_stream_idx]:
            chk(self.ctx.cuda.cuStreamSynchronize(self.stats_streams[self.last_stats_stream_idx]), f'cuStreamSynchronize(stats async ordered {self.last_stats_stream_idx})')
            self.stats_pending[self.last_stats_stream_idx] = False
            self.release_stats_payload(self.last_stats_stream_idx)
        if self.mode.use_checkpoint_replay:
            launch_kernel(self.ctx.cuda, 'channel-checkpoint-states-async', self.ctx.kernels.channel_checkpoint_states_fn, plan.checkpoint_args, grid_x=self.ctx.args.channels, block_x=1, stream=self.stats_streams[async_slot])
            launch_kernel(self.ctx.cuda, 'channel-replay-sums-async', plan.channel_kernel_fn, plan.replay_args, grid_x=plan.replay_grid, block_x=256, stream=self.stats_streams[async_slot])
        else:
            if self.mode.use_async_parallel_peaks:
                chk(self.ctx.cuda.cuEventRecord(self.stats_h2d_events[async_slot], self.stats_streams[async_slot]), f'cuEventRecord(stats async h2d {async_slot})')
                chk(self.ctx.cuda.cuStreamWaitEvent(self.stats_peak_streams[async_slot], self.stats_h2d_events[async_slot], 0), f'cuStreamWaitEvent(stats async peak {async_slot})')
                launch_kernel(self.ctx.cuda, 'window-peaks-async-parallel', self.ctx.kernels.peak_fn, plan.peak_args, grid_x=plan.peak_grid, block_x=256, stream=self.stats_peak_streams[async_slot])
                self.stats_peak_pending[async_slot] = True
            else:
                launch_kernel(self.ctx.cuda, 'window-peaks-async', self.ctx.kernels.peak_fn, plan.peak_args, grid_x=plan.peak_grid, block_x=256, stream=self.stats_streams[async_slot])
            launch_kernel(self.ctx.cuda, 'channel-stats-async', plan.channel_kernel_fn, plan.channel_args, grid_x=self.mode.channel_grid_x, block_x=self.mode.channel_block_x, stream=self.stats_streams[async_slot])
        self.stats_pending[async_slot] = True
        self.last_stats_stream_idx = async_slot
        return time.perf_counter() - kernel_t0

    def _launch_fast(self, plan):
        kernel_t0 = time.perf_counter()
        if self.mode.use_checkpoint_replay:
            launch_kernel(self.ctx.cuda, 'channel-checkpoint-states-fast', self.ctx.kernels.channel_checkpoint_states_fn, plan.checkpoint_args, grid_x=self.ctx.args.channels, block_x=1)
            launch_kernel(self.ctx.cuda, 'channel-replay-sums-fast', plan.channel_kernel_fn, plan.replay_args, grid_x=plan.replay_grid, block_x=256)
        elif not self.mode.use_combined_peaks:
            launch_kernel(self.ctx.cuda, 'window-peaks-fast', self.ctx.kernels.peak_fn, plan.peak_args, grid_x=plan.peak_grid, block_x=256)
            launch_kernel(self.ctx.cuda, 'channel-stats-fast', plan.channel_kernel_fn, plan.channel_args, grid_x=self.mode.channel_grid_x, block_x=self.mode.channel_block_x)
        else:
            launch_kernel(self.ctx.cuda, 'channel-stats-fast', plan.channel_kernel_fn, plan.channel_args, grid_x=self.mode.channel_grid_x, block_x=self.mode.channel_block_x)
        return time.perf_counter() - kernel_t0

    def _launch_timed(self, plan):
        if self.mode.use_checkpoint_replay:
            peak_dt = launch_timed_kernel(self.ctx.cuda, 'channel-checkpoint-states', self.ctx.kernels.channel_checkpoint_states_fn, plan.checkpoint_args, grid_x=self.ctx.args.channels, block_x=1)
            channel_dt = launch_timed_kernel(self.ctx.cuda, 'channel-replay-sums', plan.channel_kernel_fn, plan.replay_args, grid_x=plan.replay_grid, block_x=256)
        else:
            peak_dt = 0.0 if self.mode.use_combined_peaks else launch_timed_kernel(self.ctx.cuda, 'window-peaks', self.ctx.kernels.peak_fn, plan.peak_args, grid_x=plan.peak_grid, block_x=256)
            channel_dt = launch_timed_kernel(self.ctx.cuda, 'channel-stats', plan.channel_kernel_fn, plan.channel_args, grid_x=self.mode.channel_grid_x, block_x=self.mode.channel_block_x)
        return peak_dt + channel_dt
