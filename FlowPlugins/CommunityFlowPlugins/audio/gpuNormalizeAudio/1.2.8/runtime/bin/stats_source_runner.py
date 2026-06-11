from __future__ import annotations

from dataclasses import dataclass

from stats_source_audit import _audit_ffmpeg_input_metrics, _finish_source_sum_audit
from stats_source_precompute import (
    _run_source_exact_precompute_stage,
    run_source_exact_precompute_pass,
)
from stats_source_stage import (
    _apply_streaming_size_update,
    _trim_source_energy_stage,
    _trim_source_exact_stage,
    _trim_source_exact_stage_fixed,
    _trim_source_input_device_stage,
)


@dataclass
class SourcePrecomputeRunner:
    ctx: object
    result: object

    def apply_streaming_size_update(self, done_bytes):
        return _apply_streaming_size_update(self.ctx, self.result, done_bytes)

    def audit_ffmpeg_input_metrics(self, tail_stage):
        return _audit_ffmpeg_input_metrics(self.ctx, self.result, tail_stage)

    def finish_source_sum_audit(self):
        return _finish_source_sum_audit(self.ctx)

    def run_pass(self):
        return run_source_exact_precompute_pass(self.ctx, self.result)

    def run_stage(self, stage, stage_start_frame, next_window, ready_windows, **kwargs):
        return _run_source_exact_precompute_stage(
            self.ctx,
            self.result,
            stage,
            stage_start_frame,
            next_window,
            ready_windows,
            **kwargs,
        )

    def trim_energy_stage(self, stage_start_frame, stage_end_frame, next_window, overlap_frames):
        return _trim_source_energy_stage(self.ctx, stage_start_frame, stage_end_frame, next_window, overlap_frames)

    def trim_exact_stage(self, stage, stage_start_frame, next_window, overlap_frames, frame_bytes, frames_per_window):
        return _trim_source_exact_stage(stage, stage_start_frame, next_window, overlap_frames, frame_bytes, frames_per_window)

    def trim_exact_stage_fixed(self, stage, active_bytes, stage_start_frame, next_window, overlap_frames, frame_bytes, frames_per_window):
        return _trim_source_exact_stage_fixed(stage, active_bytes, stage_start_frame, next_window, overlap_frames, frame_bytes, frames_per_window)

    def trim_input_device_stage(self, stage_start_frame, stage_end_frame, next_window, overlap_frames):
        return _trim_source_input_device_stage(self.ctx, stage_start_frame, stage_end_frame, next_window, overlap_frames)
