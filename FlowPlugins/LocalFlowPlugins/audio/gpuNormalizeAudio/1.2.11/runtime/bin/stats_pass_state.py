from __future__ import annotations

from dataclasses import dataclass


@dataclass
class StatsPassResult:
    nbytes: int
    mib: float
    total_samples: int
    total_frames: int
    windows: int
    seconds: float
    state_bytes: int
    stats_q_wall_time: float = 0.0
    stats_q_h2d_time: float = 0.0
    stats_q_kernel_time: float = 0.0
    stats_sums_wall_time: float = 0.0
    stats_sums_h2d_time: float = 0.0
    stats_sums_kernel_time: float = 0.0
    source_precompute_stages: int = 0
    source_precompute_wall_time: float = 0.0
    source_precompute_h2d_time: float = 0.0
    source_precompute_energy_kernel_time: float = 0.0
    source_precompute_exact_kernel_time: float = 0.0
    source_precompute_hist4_kernel_time: float = 0.0
    source_precompute_block_sums_kernel_time: float = 0.0
    source_precompute_block_prefix_kernel_time: float = 0.0
    source_precompute_block_exact_kernel_time: float = 0.0
    host_prefix_wall_time: float = 0.0
    host_prefix_cpu_time: float = 0.0
    host_prefix_d2h_time: float = 0.0
    host_prefix_h2d_time: float = 0.0
    total_h2d_time: float = 0.0
    total_d2h_time: float = 0.0


@dataclass
class StatsPassContext:
    cuda: object
    args: object
    cfg: object
    buffers: object
    kernels: object
    bindings: object
    state_bytes: int
    host_io: object
    a_coeffs: object
    emit_progress: object
