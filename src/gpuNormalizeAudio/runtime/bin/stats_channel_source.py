from __future__ import annotations

import ctypes
from dataclasses import dataclass

from stats_channel_pipeline import SourceStageConfig
from stats_source_audit import _audit_ffmpeg_input_metrics, _finish_source_sum_audit
from stats_source_precompute_stage import _run_source_exact_precompute_stage
from stats_source_stage import (
    _apply_streaming_size_update,
    _trim_source_energy_stage,
    _trim_source_exact_stage,
    _trim_source_exact_stage_fixed,
    _trim_source_input_device_stage,
)


@dataclass
class ChannelSourceStage:
    ctx: object
    result: object
    config: SourceStageConfig
    sync_async_stats: object
    source_stage_active_bytes: int = 0
    source_stage_start_frame: int = 0
    source_energy_stage_end_frame: int = 0
    source_input_stage_end_frame: int = 0
    next_source_window: int = 0

    @classmethod
    def create(cls, ctx, result, config, sync_async_stats):
        return cls(
            ctx=ctx,
            result=result,
            config=config,
            sync_async_stats=sync_async_stats,
        )

    @property
    def audit_tail(self):
        return self.config.audit_tail

    @property
    def source_stage(self):
        return self.config.source_stage

    @property
    def use_source_device_energy(self):
        return self.config.use_source_device_energy

    @property
    def use_source_device_input(self):
        return self.config.use_source_device_input

    @property
    def use_source_fixed_buffer(self):
        return self.config.use_source_fixed_buffer

    def device_input_for_chunk(self, chunk):
        cfg = self.ctx.cfg
        source_stage_frames = (chunk.frame_offset + chunk.this_frames) - self.source_stage_start_frame
        if source_stage_frames > self.config.source_input_capacity_frames:
            raise RuntimeError(f'source input staging exceeded: need_frames={source_stage_frames} capacity_frames={self.config.source_input_capacity_frames}')
        source_stage_offset_frames = chunk.frame_offset - self.source_stage_start_frame
        if source_stage_offset_frames < 0:
            raise RuntimeError(f'source input staging underflow: chunk_frame={chunk.frame_offset} stage_start={self.source_stage_start_frame}')
        input_ptr = ctypes.c_void_p(self.ctx.buffers.d_in.value + (source_stage_offset_frames * cfg.sizing.frame_bytes))
        return input_ptr, ctypes.c_uint64(input_ptr.value)

    def source_energy_kernel_args(self, chunk):
        cfg = self.ctx.cfg
        source_stage_frames = (chunk.frame_offset + chunk.this_frames) - self.source_stage_start_frame
        if source_stage_frames > self.config.source_energy_capacity_frames:
            raise RuntimeError(f'source energy staging exceeded: need_frames={source_stage_frames} capacity_frames={self.config.source_energy_capacity_frames}')
        return ctypes.c_uint32(self.source_stage_start_frame), ctypes.c_uint32(self.config.source_energy_capacity_frames)

    def append_audit_tail(self, chunk_view):
        audit_tail = self.config.audit_tail
        if audit_tail is None:
            return
        cfg = self.ctx.cfg
        audit_tail.extend(chunk_view)
        excess = len(audit_tail) - cfg.sizing.audit_input_tail_bytes
        if excess > 0:
            del audit_tail[:excess]

    def process_after_chunk(self, chunk, chunk_view, done_bytes):
        self.append_audit_tail(chunk_view)
        if self.config.use_source_device_energy:
            self._process_source_device_energy(chunk, done_bytes)
        elif self.config.use_source_device_input:
            self._process_source_device_input(chunk, done_bytes)
        elif self.config.source_stage is not None:
            self._process_host_source_stage(chunk, chunk_view, done_bytes)

    def finish(self, done_bytes):
        cfg = self.ctx.cfg
        if cfg.root.streaming_io:
            _apply_streaming_size_update(self.ctx, self.result, done_bytes)
        if self.config.use_source_device_energy:
            self._finish_source_device_energy()
        elif self.config.use_source_device_input:
            self._finish_source_device_input()
        elif self.config.source_stage is not None:
            self._finish_host_source_stage()

    def audit_ffmpeg_input_metrics(self):
        if self.config.audit_tail is not None:
            _audit_ffmpeg_input_metrics(self.ctx, self.result, self.config.audit_tail)

    def _emit_progress(self, done_bytes):
        self.ctx.emit_progress('stats_sums', 0.70 * (done_bytes / float(self.ctx.cfg.input_shape.nbytes)))

    def _run_stage(self, stage, ready_windows, **kwargs):
        self.next_source_window = _run_source_exact_precompute_stage(
            self.ctx,
            self.result,
            stage,
            self.source_stage_start_frame,
            self.next_source_window,
            ready_windows,
            **kwargs,
        )

    def _process_source_device_energy(self, chunk, done_bytes):
        cfg = self.ctx.cfg
        self.source_energy_stage_end_frame = chunk.frame_offset + chunk.this_frames
        full_ready_windows = min(self.result.windows, self.source_energy_stage_end_frame // cfg.input_shape.frames_per_window)
        while full_ready_windows - self.next_source_window >= cfg.sizing.source_precompute_windows:
            self.sync_async_stats('stats async source device precompute')
            ready_windows = self.next_source_window + cfg.sizing.source_precompute_windows
            self._run_stage(None, ready_windows, device_energy_end_frame=self.source_energy_stage_end_frame)
            self._emit_progress(done_bytes)
            self.source_stage_start_frame = _trim_source_energy_stage(
                self.ctx,
                self.source_stage_start_frame,
                self.source_energy_stage_end_frame,
                self.next_source_window,
                self.config.source_overlap_frames,
            )

    def _finish_source_device_energy(self):
        if self.result.windows > self.next_source_window:
            self.sync_async_stats('stats async final source device precompute')
            self._run_stage(None, self.result.windows, device_energy_end_frame=self.source_energy_stage_end_frame)
        if self.next_source_window != self.result.windows:
            raise RuntimeError(f'fused source device precompute incomplete: windows={self.next_source_window} expected={self.result.windows}')
        _finish_source_sum_audit(self.ctx)

    def _process_source_device_input(self, chunk, done_bytes):
        cfg = self.ctx.cfg
        self.source_input_stage_end_frame = chunk.frame_offset + chunk.this_frames
        full_ready_windows = min(self.result.windows, self.source_input_stage_end_frame // cfg.input_shape.frames_per_window)
        while full_ready_windows - self.next_source_window >= cfg.sizing.source_precompute_windows:
            ready_windows = self.next_source_window + cfg.sizing.source_precompute_windows
            self._run_stage(None, ready_windows, device_input_end_frame=self.source_input_stage_end_frame)
            self._emit_progress(done_bytes)
            self.source_stage_start_frame = _trim_source_input_device_stage(
                self.ctx,
                self.source_stage_start_frame,
                self.source_input_stage_end_frame,
                self.next_source_window,
                self.config.source_overlap_frames,
            )

    def _finish_source_device_input(self):
        if self.result.windows > self.next_source_window:
            self._run_stage(None, self.result.windows, device_input_end_frame=self.source_input_stage_end_frame)
        if self.next_source_window != self.result.windows:
            raise RuntimeError(f'fused source input precompute incomplete: windows={self.next_source_window} expected={self.result.windows}')
        _finish_source_sum_audit(self.ctx)

    def _append_host_stage(self, chunk_view):
        cfg = self.ctx.cfg
        source_stage = self.config.source_stage
        if self.config.use_source_fixed_buffer:
            next_stage_bytes = self.source_stage_active_bytes + len(chunk_view)
            if next_stage_bytes > len(source_stage):
                raise RuntimeError(f'source fixed staging exceeded: need={next_stage_bytes} capacity={len(source_stage)}')
            memoryview(source_stage)[self.source_stage_active_bytes:next_stage_bytes] = chunk_view
            self.source_stage_active_bytes = next_stage_bytes
            return self.source_stage_active_bytes // cfg.sizing.frame_bytes
        source_stage.extend(chunk_view)
        return len(source_stage) // cfg.sizing.frame_bytes

    def _process_host_source_stage(self, chunk, chunk_view, done_bytes):
        cfg = self.ctx.cfg
        stage_frames = self._append_host_stage(chunk_view)
        stage_end_frame = self.source_stage_start_frame + stage_frames
        full_ready_windows = min(self.result.windows, stage_end_frame // cfg.input_shape.frames_per_window)
        while full_ready_windows - self.next_source_window >= cfg.sizing.source_precompute_windows:
            self.sync_async_stats('stats async source precompute')
            ready_windows = self.next_source_window + cfg.sizing.source_precompute_windows
            self._run_stage(
                self.config.source_stage,
                ready_windows,
                stage_active_bytes=self.source_stage_active_bytes if self.config.use_source_fixed_buffer else None,
            )
            self._emit_progress(done_bytes)
            self._trim_host_stage()

    def _finish_host_source_stage(self):
        if self.result.windows > self.next_source_window:
            self.sync_async_stats('stats async final source precompute')
            self._run_stage(
                self.config.source_stage,
                self.result.windows,
                stage_active_bytes=self.source_stage_active_bytes if self.config.use_source_fixed_buffer else None,
            )
        if self.next_source_window != self.result.windows:
            raise RuntimeError(f'fused source exact precompute incomplete: windows={self.next_source_window} expected={self.result.windows}')
        _finish_source_sum_audit(self.ctx)

    def _trim_host_stage(self):
        cfg = self.ctx.cfg
        if self.config.use_source_fixed_buffer:
            self.source_stage_start_frame, self.source_stage_active_bytes = _trim_source_exact_stage_fixed(
                self.config.source_stage,
                self.source_stage_active_bytes,
                self.source_stage_start_frame,
                self.next_source_window,
                self.config.source_overlap_frames,
                cfg.sizing.frame_bytes,
                cfg.input_shape.frames_per_window,
            )
        else:
            self.source_stage_start_frame = _trim_source_exact_stage(
                self.config.source_stage,
                self.source_stage_start_frame,
                self.next_source_window,
                self.config.source_overlap_frames,
                cfg.sizing.frame_bytes,
                cfg.input_shape.frames_per_window,
            )
