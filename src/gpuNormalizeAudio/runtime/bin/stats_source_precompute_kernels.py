from __future__ import annotations

import ctypes
import time
from dataclasses import dataclass

from cuda_launch import launch_kernel, launch_timed_kernel
import kernel_args
from source_exact_modes import selected_source_exact_kernel_variant
from stats_source_stage import (
    _source_block_output_arg,
    _source_exact_output_arg,
)


@dataclass(frozen=True)
class SourcePrecomputeKernelTimes:
    energy_dt: float = 0.0
    source_exact_dt: float = 0.0
    hist4_dt: float = 0.0
    block_sums_dt: float = 0.0
    block_prefix_dt: float = 0.0
    block_exact_dt: float = 0.0

    @property
    def total_dt(self):
        return self.energy_dt + self.source_exact_dt + self.hist4_dt + self.block_sums_dt + self.block_prefix_dt + self.block_exact_dt


def _launch_source_precompute_kernel(ctx, label, kernel_fn, launch_args, *, grid_x=1, block_x=1):
    if ctx.cfg.exact.source_precompute_fast_launch:
        t0 = time.perf_counter()
        launch_kernel(ctx.cuda, label, kernel_fn, launch_args, grid_x=grid_x, block_x=block_x)
        return time.perf_counter() - t0
    return launch_timed_kernel(ctx.cuda, label, kernel_fn, launch_args, grid_x=grid_x, block_x=block_x)


def run_source_precompute_stage_kernels(ctx, stage_input, *, next_window, ready_windows):
    cfg = ctx.cfg
    input_base_arg = stage_input.input_base_arg
    input_frames_arg = stage_input.input_frames_arg
    target_start_arg = stage_input.target_start_arg
    target_windows_arg = stage_input.target_windows_arg
    copy_frames = stage_input.copy_frames
    grid_windows = stage_input.grid_windows
    using_device_energy = stage_input.using_device_energy
    energy_dt = 0.0
    source_exact_dt = 0.0
    hist4_dt = 0.0
    block_sums_dt = 0.0
    block_prefix_dt = 0.0
    block_exact_dt = 0.0
    if ctx.cfg.source.source_channel_hist4_boundary:
        boundary_margin_ratio_arg = ctypes.c_double(ctx.cfg.source.source_channel_hist4_margin_ratio)
        hist4_args = kernel_args.build_source_selective_hist4_sums_args(
            ctx.bindings.in_arg,
            ctx.bindings.source_start_states_arg,
            ctx.bindings.source_exact_sums_arg,
            ctx.bindings.start_states_arg,
            ctx.bindings.hist_boundaries_arg,
            ctx.bindings.total_frames_arg,
            input_base_arg,
            input_frames_arg,
            target_start_arg,
            target_windows_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.windows_arg,
            ctx.bindings.b_arg,
            ctx.bindings.a_arg,
            boundary_margin_ratio_arg,
        )
        hist4_dt += launch_timed_kernel(ctx.cuda, 'source-selective-hist4-precompute', ctx.kernels.source_selective_hist4_sums_fn, hist4_args, grid_x=grid_windows, block_x=128)

    if ctx.cfg.source.source_channel_hist4_exact or ctx.cfg.source.source_channel_short_exact or ctx.cfg.source.source_channel_short_boundary:
        energy_args = kernel_args.build_source_energy_args(
            ctx.bindings.in_arg,
            ctx.bindings.source_energy_arg,
            ctx.bindings.source_start_states_arg,
            ctx.bindings.total_frames_arg,
            input_base_arg,
            input_frames_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.b_arg,
            ctx.bindings.a_arg,
        )
        energy_windows = (copy_frames + cfg.input_shape.frames_per_window - 1) // cfg.input_shape.frames_per_window
        energy_pairs = max(1, energy_windows * ctx.args.channels)
        if ctx.cfg.exact.source_energy_packed:
            energy_grid = min(65535, max(1, (energy_pairs + 31) // 32))
            energy_fn = ctx.kernels.source_energy_packed_hoist_fn if getattr(ctx.cfg.exact, 'source_energy_coeff_hoist', False) else ctx.kernels.source_energy_packed_fn
            energy_label = 'source-exact-energy-packed-hoist' if getattr(ctx.cfg.exact, 'source_energy_coeff_hoist', False) else 'source-exact-energy-packed-fast'
            energy_dt += _launch_source_precompute_kernel(ctx, energy_label, energy_fn, energy_args, grid_x=energy_grid, block_x=32)
        else:
            energy_dt += _launch_source_precompute_kernel(ctx, 'source-exact-energy-fast', ctx.kernels.source_energy_fn, energy_args, grid_x=energy_pairs, block_x=1)
    if ctx.cfg.source.source_channel_hist4_exact:
        null_arg = ctypes.c_uint64(0)
        selective_boundary_arg = ctypes.c_uint32(0)
        boundary_margin_ratio_arg = ctypes.c_double(ctx.cfg.source.source_channel_hist4_margin_ratio)
        hist4_args = kernel_args.build_source_exact_hist4_sums_args(
            ctx.bindings.source_energy_arg,
            ctx.bindings.source_exact_sums_arg,
            null_arg,
            null_arg,
            ctx.bindings.total_frames_arg,
            input_base_arg,
            input_frames_arg,
            target_start_arg,
            target_windows_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.windows_arg,
            boundary_margin_ratio_arg,
            selective_boundary_arg,
        )
        hist4_dt += launch_timed_kernel(ctx.cuda, 'source-exact-hist4-precompute', ctx.kernels.source_exact_hist4_sums_fn, hist4_args, grid_x=grid_windows, block_x=128)
    if ctx.cfg.source.source_channel_short_exact:
        short_args = kernel_args.build_source_exact_short_sums_args(
            ctx.bindings.source_energy_arg,
            ctx.bindings.source_exact_sums_arg,
            ctx.bindings.total_frames_arg,
            input_base_arg,
            input_frames_arg,
            target_start_arg,
            target_windows_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.windows_arg,
        )
        source_exact_dt += launch_timed_kernel(ctx.cuda, 'source-exact-short-precompute', ctx.kernels.source_exact_short_sums_fn, short_args, grid_x=grid_windows, block_x=128)
    elif ctx.cfg.source.source_channel_short_boundary:
        short_args = kernel_args.build_source_selective_short_sums_args(
            ctx.bindings.source_energy_arg,
            ctx.bindings.source_exact_sums_arg,
            ctx.bindings.start_states_arg,
            ctx.bindings.hist_energies_arg,
            ctx.bindings.hist_boundaries_arg,
            ctx.bindings.total_frames_arg,
            input_base_arg,
            input_frames_arg,
            target_start_arg,
            target_windows_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.windows_arg,
            ctypes.c_double(ctx.args.measured_thresh if ctx.args.measured_thresh is not None else -70.0),
            ctypes.c_double(ctx.cfg.source.source_channel_short_margin_lu),
            ctypes.c_uint32(ctx.cfg.source.source_channel_short_halo_windows),
        )
        source_exact_dt += launch_timed_kernel(ctx.cuda, 'source-selective-short-precompute', ctx.kernels.source_selective_short_sums_fn, short_args, grid_x=1, block_x=1)
    elif getattr(ctx.cfg.source, 'source_channel_short_raw_boundary', False):
        mark_args = kernel_args.build_source_mark_short_raw_corrections_args(
            ctx.bindings.source_exact_sums_arg,
            ctx.bindings.source_correction_flags_arg,
            ctx.bindings.start_states_arg,
            ctx.bindings.hist_energies_arg,
            ctx.bindings.hist_boundaries_arg,
            target_start_arg,
            target_windows_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.windows_arg,
            ctypes.c_double(ctx.args.measured_thresh if ctx.args.measured_thresh is not None else -70.0),
            ctypes.c_double(ctx.cfg.source.source_channel_short_margin_lu),
            ctypes.c_uint32(ctx.cfg.source.source_channel_short_halo_windows),
        )
        source_exact_dt += launch_timed_kernel(ctx.cuda, 'source-mark-short-raw-corrections', ctx.kernels.source_mark_short_raw_corrections_fn, mark_args, grid_x=1, block_x=1)
        apply_args = kernel_args.build_source_apply_short_raw_corrections_args(
            ctx.bindings.in_arg,
            ctx.bindings.source_start_states_arg,
            ctx.bindings.source_exact_sums_arg,
            ctx.bindings.source_correction_flags_arg,
            ctx.bindings.total_frames_arg,
            input_base_arg,
            input_frames_arg,
            target_start_arg,
            target_windows_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.windows_arg,
            ctx.bindings.b_arg,
            ctx.bindings.a_arg,
        )
        source_exact_dt += launch_timed_kernel(ctx.cuda, 'source-apply-short-raw-corrections', ctx.kernels.source_apply_short_raw_corrections_fn, apply_args, grid_x=grid_windows, block_x=128)
    elif not ctx.cfg.source.source_precompute_from_channel_sums:
        if not using_device_energy:
            energy_args = kernel_args.build_source_energy_args(
                ctx.bindings.in_arg,
                ctx.bindings.source_energy_arg,
                ctx.bindings.source_start_states_arg,
                ctx.bindings.total_frames_arg,
                input_base_arg,
                input_frames_arg,
                ctx.bindings.channels_arg,
                ctx.bindings.frame_window_arg,
                ctx.bindings.b_arg,
                ctx.bindings.a_arg,
            )
            energy_windows = (copy_frames + cfg.input_shape.frames_per_window - 1) // cfg.input_shape.frames_per_window
            energy_pairs = max(1, energy_windows * ctx.args.channels)
            if ctx.cfg.exact.source_energy_packed:
                energy_grid = min(65535, max(1, (energy_pairs + 31) // 32))
                energy_dt += _launch_source_precompute_kernel(ctx, 'source-exact-energy-packed', ctx.kernels.source_energy_packed_fn, energy_args, grid_x=energy_grid, block_x=32)
            else:
                energy_dt += _launch_source_precompute_kernel(ctx, 'source-exact-energy', ctx.kernels.source_energy_fn, energy_args, grid_x=energy_pairs, block_x=1)
        source_args = kernel_args.build_source_exact_sums_args(
            ctx.bindings.source_energy_arg,
            _source_exact_output_arg(ctx),
            ctx.bindings.source_start_states_arg,
            ctx.bindings.total_frames_arg,
            input_base_arg,
            input_frames_arg,
            target_start_arg,
            target_windows_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.windows_arg,
            ctx.bindings.b_arg,
            ctx.bindings.a_arg,
        )
        if ctx.cfg.source.source_sum_audit or not ctx.cfg.source.source_block_sums:
            source_pairs = (ready_windows - next_window) * 2
            source_block_x = getattr(ctx.cfg.exact, 'source_exact_sums_block_x', 128)
            source_grid = min(65535, max(1, (source_pairs + source_block_x - 1) // source_block_x))
            source_exact_variant = selected_source_exact_kernel_variant(ctx.cfg)
            source_exact_fn = getattr(ctx.kernels, source_exact_variant.attr)
            source_exact_label = source_exact_variant.runtime_label('source-exact-precompute')
            source_exact_dt += _launch_source_precompute_kernel(ctx, source_exact_label, source_exact_fn, source_args, grid_x=source_grid, block_x=source_block_x)
    if (not ctx.cfg.source.source_channel_hist4_exact) and ctx.cfg.source.source_block_sum_candidate:
        block_frames_arg = ctypes.c_uint32(ctx.cfg.source.source_block_frames)
        block_count = (copy_frames + ctx.cfg.source.source_block_frames - 1) // ctx.cfg.source.source_block_frames
        block_count_arg = ctypes.c_uint32(block_count)
        block_pairs = max(1, block_count * ctx.args.channels)
        block_grid = min(65535, max(1, (block_pairs + 255) // 256))
        block_args = kernel_args.build_source_block_sums_args(
            ctx.bindings.source_energy_arg,
            ctx.bindings.source_block_sums_arg,
            input_frames_arg,
            ctx.bindings.channels_arg,
            block_frames_arg,
        )
        block_prefix_args = kernel_args.build_source_block_prefix_sums_args(
            ctx.bindings.source_block_sums_arg,
            block_count_arg,
            ctx.bindings.channels_arg,
        )
        block_exact_args = kernel_args.build_source_block_exact_sums_args(
            ctx.bindings.source_energy_arg,
            ctx.bindings.source_block_sums_arg,
            _source_block_output_arg(ctx),
            ctx.bindings.total_frames_arg,
            input_base_arg,
            input_frames_arg,
            target_start_arg,
            target_windows_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.windows_arg,
            block_frames_arg,
        )
        block_sums_dt += launch_timed_kernel(ctx.cuda, 'source-block-sums', ctx.kernels.source_block_sums_fn, block_args, grid_x=block_grid, block_x=256)
        block_prefix_dt += launch_timed_kernel(ctx.cuda, 'source-block-prefix-sums', ctx.kernels.source_block_prefix_sums_fn, block_prefix_args, grid_x=ctx.args.channels, block_x=1)
        block_exact_dt += launch_timed_kernel(ctx.cuda, 'source-block-precompute', ctx.kernels.source_block_exact_sums_fn, block_exact_args, grid_x=grid_windows, block_x=128)
        exact_after_window = getattr(ctx.cfg.source, 'source_block_exact_after_window', -1)
        if exact_after_window >= 0:
            exact_start_window = max(next_window, exact_after_window)
            exact_until_window = getattr(ctx.cfg.source, 'source_block_exact_until_window', -1)
            exact_end_window = ready_windows
            if exact_until_window >= 0:
                exact_end_window = min(exact_end_window, exact_until_window)
            if exact_start_window < exact_end_window:
                exact_target_start_arg = ctypes.c_uint32(exact_start_window)
                exact_target_windows_arg = ctypes.c_uint32(exact_end_window - exact_start_window)
                exact_after_args = kernel_args.build_source_exact_sums_args(
                    ctx.bindings.source_energy_arg,
                    ctx.bindings.source_exact_sums_arg,
                    ctx.bindings.source_start_states_arg,
                    ctx.bindings.total_frames_arg,
                    input_base_arg,
                    input_frames_arg,
                    exact_target_start_arg,
                    exact_target_windows_arg,
                    ctx.bindings.channels_arg,
                    ctx.bindings.frame_window_arg,
                    ctx.bindings.windows_arg,
                    ctx.bindings.b_arg,
                    ctx.bindings.a_arg,
                )
                exact_pairs = (exact_end_window - exact_start_window) * 2
                exact_block_x = getattr(ctx.cfg.exact, 'source_exact_sums_block_x', 128)
                exact_grid = min(65535, max(1, (exact_pairs + exact_block_x - 1) // exact_block_x))
                exact_after_variant = selected_source_exact_kernel_variant(ctx.cfg)
                exact_after_fn = getattr(ctx.kernels, exact_after_variant.attr)
                exact_after_label = exact_after_variant.runtime_label('source-block-exact-after')
                source_exact_dt += _launch_source_precompute_kernel(ctx, exact_after_label, exact_after_fn, exact_after_args, grid_x=exact_grid, block_x=exact_block_x)
    return SourcePrecomputeKernelTimes(
        energy_dt=energy_dt,
        source_exact_dt=source_exact_dt,
        hist4_dt=hist4_dt,
        block_sums_dt=block_sums_dt,
        block_prefix_dt=block_prefix_dt,
        block_exact_dt=block_exact_dt,
    )
