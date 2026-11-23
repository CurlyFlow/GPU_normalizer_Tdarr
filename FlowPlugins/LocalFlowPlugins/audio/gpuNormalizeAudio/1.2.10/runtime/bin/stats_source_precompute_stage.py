import time

from stats_source_audit import _audit_source_sums_stage
from stats_source_precompute_input import copy_source_precompute_stage_input, plan_source_precompute_stage_input
from stats_source_precompute_kernels import run_source_precompute_stage_kernels


def _run_source_exact_precompute_stage(ctx, result, stage, stage_start_frame, next_window, ready_windows, *, device_energy_end_frame=None, device_input_end_frame=None, stage_active_bytes=None):
    if ready_windows <= next_window:
        return next_window
    stage_input = plan_source_precompute_stage_input(
        ctx,
        result,
        stage,
        stage_start_frame,
        next_window,
        ready_windows,
        device_energy_end_frame=device_energy_end_frame,
        device_input_end_frame=device_input_end_frame,
        stage_active_bytes=stage_active_bytes,
    )
    stage_t0 = time.perf_counter()
    copy_dt = copy_source_precompute_stage_input(ctx, stage, stage_input)
    kernel_times = run_source_precompute_stage_kernels(ctx, stage_input, next_window=next_window, ready_windows=ready_windows)
    source_stage_wall_dt = time.perf_counter() - stage_t0
    result.stats_sums_h2d_time += copy_dt
    result.total_h2d_time += copy_dt
    result.stats_sums_kernel_time += kernel_times.total_dt
    result.stats_sums_wall_time += source_stage_wall_dt
    result.source_precompute_stages += 1
    result.source_precompute_wall_time += source_stage_wall_dt
    result.source_precompute_h2d_time += copy_dt
    result.source_precompute_energy_kernel_time += kernel_times.energy_dt
    result.source_precompute_exact_kernel_time += kernel_times.source_exact_dt
    result.source_precompute_hist4_kernel_time += kernel_times.hist4_dt
    result.source_precompute_block_sums_kernel_time += kernel_times.block_sums_dt
    result.source_precompute_block_prefix_kernel_time += kernel_times.block_prefix_dt
    result.source_precompute_block_exact_kernel_time += kernel_times.block_exact_dt
    if ctx.cfg.source.source_sum_audit:
        _audit_source_sums_stage(ctx, result, next_window, ready_windows - next_window)
    return ready_windows
