from __future__ import annotations

from dataclasses import dataclass

from runtime_profile import SegmentedSafeFeedbackProfile


@dataclass
class ApplyPassResult:
    apply_wall_time: float = 0.0
    apply_h2d_time: float = 0.0
    apply_kernel_time: float = 0.0
    apply_d2h_time: float = 0.0
    apply_write_time: float = 0.0
    apply_stream_close_time: float = 0.0
    apply_stream_window_close_time: float = 0.0
    apply_decode_wait_time: float = 0.0
    apply_encode_close_time: float = 0.0
    apply_encode_wait_time: float = 0.0
    apply_async_write: int = 0
    apply_async_write_worker_time: float = 0.0
    apply_async_write_close_wait_time: float = 0.0
    apply_async_write_peak_queue: int = 0
    apply_async_write_borrowed_writes: int = 0
    apply_async_write_borrowed_bytes: int = 0
    apply_async_write_cuda_event_writes: int = 0
    apply_async_write_cuda_event_wait_time: float = 0.0
    apply_async_output_borrow_wait_time: float = 0.0
    apply_async_output_borrowed_writes: int = 0
    apply_async_output_borrowed_bytes: int = 0
    apply_async_output_borrowed_peak_slots: int = 0
    apply_setup_wall_time: float = 0.0
    apply_path: str = 'sync_pageable'
    apply_pinned: int = 0
    apply_stream_count: int = 0
    apply_async_fallback: str = 'none'
    exact_risk_gate_safe_chunks: int = 0
    exact_risk_gate_total_chunks: int = 0
    exact_sparse_chunk_splits: int = 0
    exact_safe_kernel_time: float = 0.0
    exact_unsafe_kernel_time: float = 0.0
    exact_prefill_kernel_time: float = 0.0
    exact_safe_apply_kernel_time: float = 0.0
    exact_unsafe_apply_kernel_time: float = 0.0
    exact_safe_chunks: int = 0
    exact_unsafe_chunks: int = 0
    exact_skip_safe_fill_chunks: int = 0
    segmented_safe_feedback_profile: SegmentedSafeFeedbackProfile | None = None
    exact_counts_host: object | None = None
    ffmpeg_state_audit_i_host: object | None = None
    ffmpeg_state_audit_d_host: object | None = None
    ffmpeg_state_audit_snapshot_i_host: object | None = None
    ffmpeg_state_audit_snapshot_d_host: object | None = None
    ffmpeg_state_audit_snapshot_count: int = 0
    first_pass_output_metric_kernel_time: float = 0.0
    total_h2d_time: float = 0.0
    total_d2h_time: float = 0.0

    def __post_init__(self):
        if self.segmented_safe_feedback_profile is None:
            self.segmented_safe_feedback_profile = SegmentedSafeFeedbackProfile()


@dataclass
class ApplyPassContext:
    cuda: object
    cuda_session: object
    args: object
    cfg: object
    buffers: object
    kernels: object
    bindings: object
    host_io: object
    a_coeffs: object
    prelimiter_unsafe_flags: list[int] | None
    emit_progress: object
