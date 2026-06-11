from __future__ import annotations

import array
import ctypes
import time
from types import SimpleNamespace

from cuda_driver import chk
from cuda_launch import launch_kernel, launch_timed_kernel
from feedback_apply import (
    FB_D_OUT_STATES,
    FB_D_OUT_STATE_VALUES,
    FEEDBACK_STATE_D_WORDS,
    copy_feedback_out_states_to_device,
    copy_feedback_state_d_from_device,
    feedback_state_i_view,
)
from feedback_modes import can_parallel_skip_safe_feedback, can_prefix_skip_safe_feedback, select_feedback_apply_mode
import kernel_args
from runtime_env import env_flag


CHANNEL_TO_SLOT_6 = (0, 1, 2, -1, 3, 4)


def _inline_first_pass_output_sums(ctx):
    return bool(ctx.cfg.emit_first_pass_json and env_flag('LOUDNORM_GPU_FIRST_PASS_OUTPUT_INLINE_SUMS'))


def _output_sums_arg(ctx):
    return ctx.bindings.channel_sums_arg if _inline_first_pass_output_sums(ctx) else ctypes.c_uint64(0)


def launch_apply_kernel(ctx, profile_label, kernel_fn, launch_args, *, grid_x=1, block_x=1, check_label=None):
    if ctx.cfg.exact_apply_fast_launch:
        t0 = time.perf_counter()
        launch_kernel(ctx.cuda, profile_label, kernel_fn, launch_args, grid_x=grid_x, block_x=block_x, check_label=check_label)
        return time.perf_counter() - t0
    return launch_timed_kernel(ctx.cuda, profile_label, kernel_fn, launch_args, grid_x=grid_x, block_x=block_x, check_label=check_label)


def _source_safe_feedback_args(ctx, *, frame_specialized=False, skip_lookahead_scan_6ch=False, skip_fill_peak_scan_6ch=False):
    frame_mode = 16 if frame_specialized else 0
    rolling_ring_mode = 32 if getattr(ctx.cfg, 'exact_skip_apply_rolling_ring_6ch', False) and ctx.args.channels == 6 else 0
    skip_scan_6ch_mode = 64 if skip_lookahead_scan_6ch and ctx.args.channels == 6 and env_flag('LOUDNORM_GPU_SAFE_SKIP_6CH_SKIP_LOOKAHEAD_SCAN', True) else 0
    single_wrap_safe = (
        getattr(ctx.cfg, 'exact_safe_skip_6ch_single_wrap', False)
        and ctx.args.channels == 6
        and ctx.cfg.limiter_lookahead_frames > (ctx.cfg.frames_per_window + ctx.bindings.attack_length_arg.value)
    )
    single_wrap_mode = 128 if single_wrap_safe else 0
    skip_direct_clamp_mode = 256 if ctx.args.channels == 6 and env_flag('LOUDNORM_GPU_SAFE_SKIP_6CH_SKIP_DIRECT_CLAMP') else 0
    skip_fill_peak_scan_mode = 512 if skip_fill_peak_scan_6ch and ctx.args.channels == 6 and env_flag('LOUDNORM_GPU_SAFE_SKIP_6CH_SKIP_FILL_PEAK_SCAN') else 0
    if not ctx.cfg.source_exact_precompute:
        return ctypes.c_uint64(0), ctypes.c_uint32(frame_mode + rolling_ring_mode + skip_scan_6ch_mode + single_wrap_mode + skip_direct_clamp_mode + skip_fill_peak_scan_mode)
    source_mode = 2
    if ctx.cfg.source_skip_limiter_lookahead_scan:
        source_mode += 1
    if ctx.cfg.source_fused_direct_feedback:
        source_mode += 2
    return ctx.bindings.source_exact_sums_arg, ctypes.c_uint32(source_mode + frame_mode + rolling_ring_mode + skip_scan_6ch_mode + single_wrap_mode + skip_direct_clamp_mode + skip_fill_peak_scan_mode)


def _reused_safe_feedback_apply6_args(ctx, apply_chunk, *, frame_specialized=False, skip_lookahead_scan_6ch=False, skip_fill_peak_scan_6ch=False):
    if frame_specialized or skip_lookahead_scan_6ch or skip_fill_peak_scan_6ch or not ctx.cfg.exact_apply_arg_reuse:
        return None
    cache = getattr(ctx, '_safe_feedback_apply6_arg_cache', None)
    if cache is None:
        source_sums_arg, source_flag_arg = _source_safe_feedback_args(ctx)
        output_sums_arg = _output_sums_arg(ctx)
        cache = SimpleNamespace(
            input_base_arg=ctypes.c_uint32(0),
            input_frames_arg=ctypes.c_uint32(0),
            frames_arg=ctypes.c_uint32(0),
            source_sums_arg=source_sums_arg,
            output_sums_arg=output_sums_arg,
            source_flag_arg=source_flag_arg,
        )
        bindings = ctx.bindings
        cache.args = kernel_args.build_safe_feedback_apply6_args(
            bindings.in_arg,
            bindings.out_arg,
            bindings.sums_arg,
            bindings.hist_energies_arg,
            bindings.hist_boundaries_arg,
            bindings.limiter_buf_arg,
            bindings.limiter_prev_arg,
            bindings.feedback_state_i_arg,
            bindings.feedback_state_d_arg,
            bindings.feedback_hist_arg,
            bindings.safe_feedback_frames_arg,
            bindings.total_frames_arg,
            cache.input_base_arg,
            cache.input_frames_arg,
            cache.frames_arg,
            bindings.channels_arg,
            bindings.frame_window_arg,
            bindings.windows_arg,
            bindings.limiter_lookahead_arg,
            bindings.attack_length_arg,
            bindings.release_length_arg,
            bindings.b_arg,
            bindings.a_arg,
            bindings.exact_target_i_arg,
            bindings.exact_target_lra_arg,
            bindings.exact_measured_i_arg,
            bindings.exact_measured_thresh_arg,
            bindings.exact_offset_amp_arg,
            bindings.exact_limiter_ceiling_arg,
            cache.source_sums_arg,
            cache.output_sums_arg,
            cache.source_flag_arg,
        )
        ctx._safe_feedback_apply6_arg_cache = cache
    cache.input_base_arg.value = apply_chunk.input_base_arg.value
    cache.input_frames_arg.value = apply_chunk.input_frames_arg.value
    cache.frames_arg.value = apply_chunk.this_frames
    return cache.args


def _safe_feedback_apply6_args(ctx, apply_chunk, *, frame_specialized=False, skip_lookahead_scan_6ch=False, skip_fill_peak_scan_6ch=False):
    reused_args = _reused_safe_feedback_apply6_args(ctx, apply_chunk, frame_specialized=frame_specialized, skip_lookahead_scan_6ch=skip_lookahead_scan_6ch, skip_fill_peak_scan_6ch=skip_fill_peak_scan_6ch)
    if reused_args is not None:
        return reused_args

    bindings = ctx.bindings
    frames_arg = ctypes.c_uint32(apply_chunk.this_frames)
    source_sums_arg, source_flag_arg = _source_safe_feedback_args(ctx, frame_specialized=frame_specialized, skip_lookahead_scan_6ch=skip_lookahead_scan_6ch, skip_fill_peak_scan_6ch=skip_fill_peak_scan_6ch)
    output_sums_arg = _output_sums_arg(ctx)
    args = kernel_args.build_safe_feedback_apply6_args(
        bindings.in_arg,
        bindings.out_arg,
        bindings.sums_arg,
        bindings.hist_energies_arg,
        bindings.hist_boundaries_arg,
        bindings.limiter_buf_arg,
        bindings.limiter_prev_arg,
        bindings.feedback_state_i_arg,
        bindings.feedback_state_d_arg,
        bindings.feedback_hist_arg,
        bindings.safe_feedback_frames_arg,
        bindings.total_frames_arg,
        apply_chunk.input_base_arg,
        apply_chunk.input_frames_arg,
        frames_arg,
        bindings.channels_arg,
        bindings.frame_window_arg,
        bindings.windows_arg,
        bindings.limiter_lookahead_arg,
        bindings.attack_length_arg,
        bindings.release_length_arg,
        bindings.b_arg,
        bindings.a_arg,
        bindings.exact_target_i_arg,
        bindings.exact_target_lra_arg,
        bindings.exact_measured_i_arg,
        bindings.exact_measured_thresh_arg,
        bindings.exact_offset_amp_arg,
        bindings.exact_limiter_ceiling_arg,
        source_sums_arg,
        output_sums_arg,
        source_flag_arg,
    )
    args._refs = (frames_arg, source_sums_arg, output_sums_arg, source_flag_arg)
    return args


def _channel_start_states_from_feedback(feedback_state_d_host):
    states = array.array('d', [0.0]) * (6 * 4)
    for c, slot in enumerate(CHANNEL_TO_SLOT_6):
        if slot < 0:
            continue
        src = FB_D_OUT_STATES + (slot * 4)
        dst = c * 4
        states[dst + 0] = feedback_state_d_host[src + 0]
        states[dst + 1] = feedback_state_d_host[src + 1]
        states[dst + 2] = feedback_state_d_host[src + 2]
        states[dst + 3] = feedback_state_d_host[src + 3]
    return states


def _feedback_out_states_from_channels(channel_states):
    out_states = array.array('d', [0.0]) * FB_D_OUT_STATE_VALUES
    for c, slot in enumerate(CHANNEL_TO_SLOT_6):
        if slot < 0:
            continue
        src = c * 4
        dst = slot * 4
        out_states[dst + 0] = channel_states[src + 0]
        out_states[dst + 1] = channel_states[src + 1]
        out_states[dst + 2] = channel_states[src + 2]
        out_states[dst + 3] = channel_states[src + 3]
    return out_states


def _launch_prefix_safe_feedback(ctx, result, apply_chunk, feedback_state_i_host, *, local_windows):
    cfg = ctx.cfg
    bindings = ctx.bindings
    cuda = ctx.cuda
    channel_state_bytes = ctx.args.channels * 4 * 8
    frames_arg = ctypes.c_uint32(apply_chunk.this_frames)
    local_windows_arg = ctypes.c_uint32(local_windows)
    window_offset_arg = ctypes.c_uint32(0)

    if not cfg.exact_safe_feedback_prefix_energy or getattr(cfg, 'exact_safe_feedback_prefix_post_fill', False):
        state = feedback_state_i_view(feedback_state_i_host)
        out_frame_start = state.get('out_frame')
        write_frame_start = state.get('write_frame')
        lead_frames = write_frame_start - out_frame_start if write_frame_start >= out_frame_start else 0
        fill_gain_lead = (lead_frames + cfg.frames_per_window - 1) // cfg.frames_per_window
        fill_gain_count = fill_gain_lead + local_windows + 2
        null_feedback_arg = ctypes.c_uint64(0)
        fill_gain_lead_arg = ctypes.c_uint32(fill_gain_lead)
        fill_gain_count_arg = ctypes.c_uint32(fill_gain_count)
        stitch_args = kernel_args.build_safe_feedback_stitch_args(
            bindings.feedback_state_i_arg,
            bindings.feedback_state_d_arg,
            bindings.feedback_hist_arg,
            bindings.out_arg,
            bindings.limiter_prev_arg,
            bindings.sums_arg,
            null_feedback_arg,
            bindings.hist_energies_arg,
            bindings.hist_boundaries_arg,
            local_windows_arg,
            bindings.total_frames_arg,
            bindings.channels_arg,
            bindings.frame_window_arg,
            bindings.windows_arg,
            bindings.limiter_lookahead_arg,
            bindings.exact_target_i_arg,
            bindings.exact_target_lra_arg,
            bindings.exact_measured_i_arg,
            bindings.exact_measured_thresh_arg,
            bindings.exact_limiter_ceiling_arg,
            bindings.q_states_arg,
            fill_gain_lead_arg,
            fill_gain_count_arg,
            ctypes.c_uint32(0),
        )
        stitch_dt = launch_timed_kernel(cuda, 'safe-feedback-prefix-plan-stitch', ctx.kernels.safe_feedback_stitch_fn, stitch_args)
        output_frame_arg = ctypes.c_uint32(out_frame_start)
        write_frame_arg = ctypes.c_uint32(write_frame_start)
        fill_frames = apply_chunk.this_frames + lead_frames
        samples_arg = ctypes.c_uint32(fill_frames * ctx.args.channels)
        output_frames_arg = ctypes.c_uint32(apply_chunk.this_frames)
        fill_args = kernel_args.build_safe_feedback_fill_args(
            bindings.in_arg,
            bindings.out_arg,
            bindings.limiter_buf_arg,
            bindings.limiter_prev_arg,
            bindings.q_states_arg,
            samples_arg,
            output_frames_arg,
            bindings.channels_arg,
            bindings.frame_window_arg,
            bindings.limiter_lookahead_arg,
            output_frame_arg,
            apply_chunk.input_base_arg,
            apply_chunk.input_frames_arg,
            write_frame_arg,
            fill_gain_lead_arg,
            fill_gain_count_arg,
            bindings.exact_offset_amp_arg,
            bindings.exact_limiter_ceiling_arg,
        )
        fill_grid = min(65535, max(1, (samples_arg.value + 255) // 256))
        fill_dt = launch_timed_kernel(cuda, 'safe-feedback-prefix-fill', ctx.kernels.safe_feedback_fill_fn, fill_args, grid_x=fill_grid, block_x=256)
        energy_dt = 0.0
        window_dt = 0.0
        output_state_dt = 0.0
        if getattr(cfg, 'exact_safe_feedback_prefix_post_fill', False):
            energy_args = kernel_args.build_safe_feedback_energy_args(
                bindings.out_arg,
                bindings.safe_feedback_frames_arg,
                bindings.feedback_state_d_arg,
                frames_arg,
                bindings.channels_arg,
                bindings.b_arg,
                bindings.a_arg,
            )
            energy_dt = launch_timed_kernel(cuda, 'safe-feedback-prefix-post-fill-energy', ctx.kernels.safe_feedback_energy_fn, energy_args, grid_x=ctx.args.channels, block_x=1)
            window_grid = min(65535, max(1, (local_windows + 255) // 256))
            window_args = kernel_args.build_safe_feedback_window_args(
                bindings.safe_feedback_frames_arg,
                bindings.q_states_arg,
                frames_arg,
                bindings.frame_window_arg,
            )
            window_dt = launch_timed_kernel(cuda, 'safe-feedback-prefix-post-fill-window', ctx.kernels.safe_feedback_window_fn, window_args, grid_x=window_grid, block_x=256)
            output_state_args = kernel_args.build_safe_feedback_output_state_args(
                bindings.feedback_state_i_arg,
                bindings.feedback_state_d_arg,
                bindings.q_states_arg,
                local_windows_arg,
                bindings.frame_window_arg,
            )
            output_state_dt = launch_timed_kernel(cuda, 'safe-feedback-prefix-post-fill-output-state', ctx.kernels.safe_feedback_output_state_fn, output_state_args)
        kernel_dt = stitch_dt + fill_dt + energy_dt + window_dt + output_state_dt
        result.apply_kernel_time += kernel_dt
        result.exact_safe_kernel_time += kernel_dt
        result.exact_safe_apply_kernel_time += kernel_dt
        result.segmented_safe_feedback_profile.record_prefix(energy_dt, fill_dt + window_dt, stitch_dt + output_state_dt, local_windows)
        return 0.0

    d2h_dt = 0.0
    h2d_dt = 0.0
    energy_dt = 0.0
    if cfg.exact_safe_feedback_prefix_energy:
        energy_args = kernel_args.build_safe_feedback_energy_args(
            bindings.out_arg,
            bindings.safe_feedback_frames_arg,
            bindings.feedback_state_d_arg,
            frames_arg,
            bindings.channels_arg,
            bindings.b_arg,
            bindings.a_arg,
        )
        energy_dt = launch_timed_kernel(cuda, 'safe-feedback-prefix-energy', ctx.kernels.safe_feedback_energy_fn, energy_args, grid_x=ctx.args.channels, block_x=1)
        window_grid = min(65535, max(1, (local_windows + 255) // 256))
        window_args = kernel_args.build_safe_feedback_window_args(
            bindings.safe_feedback_frames_arg,
            bindings.q_states_arg,
            frames_arg,
            bindings.frame_window_arg,
        )
        window_dt = launch_timed_kernel(cuda, 'safe-feedback-prefix-window', ctx.kernels.safe_feedback_window_fn, window_args, grid_x=window_grid, block_x=256)
    else:
        feedback_state_d_host = array.array('d', [0.0]) * FEEDBACK_STATE_D_WORDS
        t0 = time.perf_counter()
        copy_feedback_state_d_from_device(cuda, feedback_state_d_host, ctx.buffers.d_feedback_state_d, 'cuMemcpyDtoH(prefix feedback_state_d)')
        state_d_d2h_dt = time.perf_counter() - t0

        channel_states = _channel_start_states_from_feedback(feedback_state_d_host)
        t0 = time.perf_counter()
        chk(cuda.cuMemcpyHtoD_v2(ctx.buffers.d_start_states, ctypes.c_void_p(channel_states.buffer_info()[0]), channel_state_bytes), 'cuMemcpyHtoD(prefix channel states)')
        start_h2d_dt = time.perf_counter() - t0

        channel_args = kernel_args.build_channel_stats_args(
            bindings.out_arg,
            bindings.channel_sums_arg,
            bindings.peaks_arg,
            bindings.start_states_arg,
            ctypes.c_uint64(0),
            frames_arg,
            bindings.channels_arg,
            bindings.frame_window_arg,
            window_offset_arg,
            bindings.b_arg,
            bindings.a_arg,
        )
        channel_dt = launch_timed_kernel(cuda, 'safe-feedback-prefix-channel-seq', ctx.kernels.channel_sums_fn, channel_args, grid_x=ctx.args.channels, block_x=1)

        final_channel_states = array.array('d', [0.0]) * (ctx.args.channels * 4)
        t0 = time.perf_counter()
        chk(cuda.cuMemcpyDtoH_v2(ctypes.c_void_p(final_channel_states.buffer_info()[0]), ctx.buffers.d_start_states, channel_state_bytes), 'cuMemcpyDtoH(prefix final channel states)')
        final_state_d2h_dt = time.perf_counter() - t0

        final_out_states = _feedback_out_states_from_channels(final_channel_states)
        t0 = time.perf_counter()
        copy_feedback_out_states_to_device(cuda, ctx.buffers.d_feedback_state_d, final_out_states, 'cuMemcpyHtoD(prefix out_states)')
        out_state_h2d_dt = time.perf_counter() - t0

        combine_grid = min(65535, max(1, (local_windows + 255) // 256))
        combine_args = kernel_args.build_combine_sums_args(bindings.channel_sums_arg, bindings.q_states_arg, local_windows_arg, bindings.channels_arg)
        combine_dt = launch_timed_kernel(cuda, 'safe-feedback-prefix-combine', ctx.kernels.combine_sums_fn, combine_args, grid_x=combine_grid, block_x=256)
        d2h_dt = state_d_d2h_dt + final_state_d2h_dt
        h2d_dt = start_h2d_dt + out_state_h2d_dt
        window_dt = channel_dt + combine_dt

    null_fill_arg = ctypes.c_uint64(0)
    zero_fill_lead_arg = ctypes.c_uint32(0)
    zero_fill_count_arg = ctypes.c_uint32(0)
    stitch_args = kernel_args.build_safe_feedback_stitch_args(
        bindings.feedback_state_i_arg,
        bindings.feedback_state_d_arg,
        bindings.feedback_hist_arg,
        bindings.out_arg,
        bindings.limiter_prev_arg,
        bindings.sums_arg,
        bindings.q_states_arg,
        bindings.hist_energies_arg,
        bindings.hist_boundaries_arg,
        local_windows_arg,
        bindings.total_frames_arg,
        bindings.channels_arg,
        bindings.frame_window_arg,
        bindings.windows_arg,
        bindings.limiter_lookahead_arg,
        bindings.exact_target_i_arg,
        bindings.exact_target_lra_arg,
        bindings.exact_measured_i_arg,
        bindings.exact_measured_thresh_arg,
        bindings.exact_limiter_ceiling_arg,
        null_fill_arg,
        zero_fill_lead_arg,
        zero_fill_count_arg,
        ctypes.c_uint32(0),
    )
    stitch_dt = launch_timed_kernel(cuda, 'safe-feedback-prefix-stitch', ctx.kernels.safe_feedback_stitch_fn, stitch_args)

    kernel_dt = energy_dt + window_dt + stitch_dt
    result.apply_d2h_time += d2h_dt
    result.total_d2h_time += d2h_dt
    result.apply_h2d_time += h2d_dt
    result.total_h2d_time += h2d_dt
    result.apply_kernel_time += kernel_dt
    result.exact_safe_kernel_time += kernel_dt
    result.exact_safe_apply_kernel_time += kernel_dt
    result.segmented_safe_feedback_profile.record_prefix(energy_dt, window_dt, stitch_dt, local_windows)
    return 0.0


def _launch_source_safe_run_scan_apply(ctx, result, apply_chunk, feedback_state_i_host, *, local_windows):
    cfg = ctx.cfg
    state = feedback_state_i_view(feedback_state_i_host)
    if not (
        cfg.source_safe_run_scan_apply
        and cfg.source_exact_precompute
        and ctx.args.channels == 2
        and state.enabled('above_threshold')
        and state.get('out_window_count') == 0
    ):
        return False

    bindings = ctx.bindings
    out_frame_start = state.get('out_frame')
    write_frame_start = state.get('write_frame')
    lead_frames = write_frame_start - out_frame_start if write_frame_start >= out_frame_start else 0
    fill_gain_lead = (lead_frames + cfg.frames_per_window - 1) // cfg.frames_per_window
    fill_gain_count = fill_gain_lead + local_windows + 2

    local_windows_arg = ctypes.c_uint32(local_windows)
    fill_gain_lead_arg = ctypes.c_uint32(fill_gain_lead)
    fill_gain_count_arg = ctypes.c_uint32(fill_gain_count)
    source_precomputed_arg = ctypes.c_uint32(2)
    null_feedback_arg = ctypes.c_uint64(0)
    stitch_args = kernel_args.build_safe_feedback_stitch_args(
        bindings.feedback_state_i_arg,
        bindings.feedback_state_d_arg,
        bindings.feedback_hist_arg,
        bindings.out_arg,
        bindings.limiter_prev_arg,
        bindings.source_exact_sums_arg,
        null_feedback_arg,
        bindings.hist_energies_arg,
        bindings.hist_boundaries_arg,
        local_windows_arg,
        bindings.total_frames_arg,
        bindings.channels_arg,
        bindings.frame_window_arg,
        bindings.windows_arg,
        bindings.limiter_lookahead_arg,
        bindings.exact_target_i_arg,
        bindings.exact_target_lra_arg,
        bindings.exact_measured_i_arg,
        bindings.exact_measured_thresh_arg,
        bindings.exact_limiter_ceiling_arg,
        bindings.q_states_arg,
        fill_gain_lead_arg,
        fill_gain_count_arg,
        source_precomputed_arg,
    )
    stitch_dt = launch_timed_kernel(ctx.cuda, 'source-safe-run-scan', ctx.kernels.safe_feedback_stitch_fn, stitch_args)

    fill_frames = apply_chunk.this_frames + lead_frames
    samples_arg = ctypes.c_uint32(fill_frames * ctx.args.channels)
    output_frames_arg = ctypes.c_uint32(apply_chunk.this_frames)
    output_frame_arg = ctypes.c_uint32(out_frame_start)
    write_frame_arg = ctypes.c_uint32(write_frame_start)
    fill_args = kernel_args.build_safe_feedback_fill_args(
        bindings.in_arg,
        bindings.out_arg,
        bindings.limiter_buf_arg,
        bindings.limiter_prev_arg,
        bindings.q_states_arg,
        samples_arg,
        output_frames_arg,
        bindings.channels_arg,
        bindings.frame_window_arg,
        bindings.limiter_lookahead_arg,
        output_frame_arg,
        apply_chunk.input_base_arg,
        apply_chunk.input_frames_arg,
        write_frame_arg,
        fill_gain_lead_arg,
        fill_gain_count_arg,
        bindings.exact_offset_amp_arg,
        bindings.exact_limiter_ceiling_arg,
    )
    fill_grid = min(65535, max(1, (samples_arg.value + 255) // 256))
    fill_dt = launch_apply_kernel(ctx, 'source-safe-run-fill', ctx.kernels.safe_feedback_fill_fn, fill_args, grid_x=fill_grid, block_x=256)
    kernel_dt = stitch_dt + fill_dt
    result.apply_kernel_time += kernel_dt
    result.exact_safe_kernel_time += kernel_dt
    result.exact_safe_apply_kernel_time += kernel_dt
    result.segmented_safe_feedback_profile.record_prefix(0.0, fill_dt, stitch_dt, local_windows)
    return True


def _launch_safe_run_scan_apply_6ch(ctx, result, apply_chunk, feedback_state_i_host, *, local_windows):
    cfg = ctx.cfg
    state = feedback_state_i_view(feedback_state_i_host)
    if not (
        cfg.exact_safe_run_scan_apply_6ch
        and not cfg.source_exact_precompute
        and ctx.args.channels == 6
        and state.enabled('above_threshold')
        and state.get('limiter_maybe_above_ceiling') == 0
        and state.get('out_window_count') == 0
    ):
        return False
    if not _safe_run_scan_6ch_boundary_halo_ok(ctx, apply_chunk):
        return False

    bindings = ctx.bindings
    out_frame_start = state.get('out_frame')
    write_frame_start = state.get('write_frame')
    lead_frames = write_frame_start - out_frame_start if write_frame_start >= out_frame_start else 0
    fill_gain_lead = (lead_frames + cfg.frames_per_window - 1) // cfg.frames_per_window
    fill_gain_count = fill_gain_lead + local_windows + 2

    local_windows_arg = ctypes.c_uint32(local_windows)
    fill_gain_lead_arg = ctypes.c_uint32(fill_gain_lead)
    fill_gain_count_arg = ctypes.c_uint32(fill_gain_count)
    null_feedback_arg = ctypes.c_uint64(0)
    stitch_args = kernel_args.build_safe_feedback_stitch_args(
        bindings.feedback_state_i_arg,
        bindings.feedback_state_d_arg,
        bindings.feedback_hist_arg,
        bindings.out_arg,
        bindings.limiter_prev_arg,
        bindings.sums_arg,
        null_feedback_arg,
        bindings.hist_energies_arg,
        bindings.hist_boundaries_arg,
        local_windows_arg,
        bindings.total_frames_arg,
        bindings.channels_arg,
        bindings.frame_window_arg,
        bindings.windows_arg,
        bindings.limiter_lookahead_arg,
        bindings.exact_target_i_arg,
        bindings.exact_target_lra_arg,
        bindings.exact_measured_i_arg,
        bindings.exact_measured_thresh_arg,
        bindings.exact_limiter_ceiling_arg,
        bindings.q_states_arg,
        fill_gain_lead_arg,
        fill_gain_count_arg,
        ctypes.c_uint32(0),
    )
    stitch_dt = launch_timed_kernel(ctx.cuda, 'safe-run-scan-6ch', ctx.kernels.safe_feedback_stitch_fn, stitch_args)

    fill_frames = apply_chunk.this_frames + lead_frames
    samples_arg = ctypes.c_uint32(fill_frames * ctx.args.channels)
    output_frames_arg = ctypes.c_uint32(apply_chunk.this_frames)
    output_frame_arg = ctypes.c_uint32(out_frame_start)
    write_frame_arg = ctypes.c_uint32(write_frame_start)
    fill_args = kernel_args.build_safe_feedback_fill_args(
        bindings.in_arg,
        bindings.out_arg,
        bindings.limiter_buf_arg,
        bindings.limiter_prev_arg,
        bindings.q_states_arg,
        samples_arg,
        output_frames_arg,
        bindings.channels_arg,
        bindings.frame_window_arg,
        bindings.limiter_lookahead_arg,
        output_frame_arg,
        apply_chunk.input_base_arg,
        apply_chunk.input_frames_arg,
        write_frame_arg,
        fill_gain_lead_arg,
        fill_gain_count_arg,
        bindings.exact_offset_amp_arg,
        bindings.exact_limiter_ceiling_arg,
    )
    fill_grid = min(65535, max(1, (samples_arg.value + 255) // 256))
    fill_dt = launch_apply_kernel(ctx, 'safe-run-fill-6ch', ctx.kernels.safe_feedback_fill_fn, fill_args, grid_x=fill_grid, block_x=256)
    energy_dt = 0.0
    window_dt = 0.0
    output_state_dt = 0.0
    if getattr(cfg, 'exact_safe_run_scan_apply_post_fill', False):
        frames_arg = ctypes.c_uint32(apply_chunk.this_frames)
        energy_args = kernel_args.build_safe_feedback_energy_args(
            bindings.out_arg,
            bindings.safe_feedback_frames_arg,
            bindings.feedback_state_d_arg,
            frames_arg,
            bindings.channels_arg,
            bindings.b_arg,
            bindings.a_arg,
        )
        energy_dt = launch_timed_kernel(ctx.cuda, 'safe-run-post-fill-energy-6ch', ctx.kernels.safe_feedback_energy_fn, energy_args, grid_x=ctx.args.channels, block_x=1)
        window_grid = min(65535, max(1, (local_windows + 255) // 256))
        window_args = kernel_args.build_safe_feedback_window_args(
            bindings.safe_feedback_frames_arg,
            bindings.q_states_arg,
            frames_arg,
            bindings.frame_window_arg,
        )
        window_dt = launch_timed_kernel(ctx.cuda, 'safe-run-post-fill-window-6ch', ctx.kernels.safe_feedback_window_fn, window_args, grid_x=window_grid, block_x=256)
        output_state_args = kernel_args.build_safe_feedback_output_state_args(
            bindings.feedback_state_i_arg,
            bindings.feedback_state_d_arg,
            bindings.q_states_arg,
            local_windows_arg,
            bindings.frame_window_arg,
        )
        output_state_dt = launch_timed_kernel(ctx.cuda, 'safe-run-post-fill-output-state-6ch', ctx.kernels.safe_feedback_output_state_fn, output_state_args)
    kernel_dt = stitch_dt + fill_dt + energy_dt + window_dt + output_state_dt
    result.apply_kernel_time += kernel_dt
    result.exact_safe_kernel_time += kernel_dt
    result.exact_safe_apply_kernel_time += kernel_dt
    result.segmented_safe_feedback_profile.record_prefix(energy_dt, fill_dt + window_dt, stitch_dt + output_state_dt, local_windows)
    return True


def _safe_run_scan_6ch_boundary_halo_ok(ctx, apply_chunk):
    halo_windows = int(getattr(ctx.cfg, 'exact_safe_run_scan_apply_6ch_boundary_halo_windows', 0) or 0)
    if halo_windows <= 0:
        return True
    flags = ctx.prelimiter_unsafe_flags
    if flags is None or ctx.cfg.frames_per_window <= 0:
        return False
    frame_offset = int(apply_chunk.input_base_arg.value if apply_chunk.input_base_arg is not None else 0)
    this_frames = int(apply_chunk.this_frames)
    if frame_offset % ctx.cfg.frames_per_window != 0 or this_frames % ctx.cfg.frames_per_window != 0:
        return False
    first_window = frame_offset // ctx.cfg.frames_per_window
    chunk_end_window = (frame_offset + this_frames) // ctx.cfg.frames_per_window
    if first_window < 0 or first_window >= len(flags) or chunk_end_window > len(flags):
        return False
    if flags[first_window] != 0:
        return False
    run_start_window = first_window
    while run_start_window > 0 and flags[run_start_window - 1] == 0:
        run_start_window -= 1
    run_end_window = None
    if ctx.prelimiter_run_end_window is not None and first_window < len(ctx.prelimiter_run_end_window):
        run_end_window = ctx.prelimiter_run_end_window[first_window]
    if run_end_window is None:
        run_end_window = first_window + 1
        while run_end_window < len(flags) and flags[run_end_window] == 0:
            run_end_window += 1
    if chunk_end_window > run_end_window:
        return False
    return first_window - run_start_window >= halo_windows and run_end_window - chunk_end_window >= halo_windows


def _launch_parallel_unsafe_feedback(ctx, result, apply_chunk, feedback_state_i_host, *, local_windows):
    cfg = ctx.cfg
    unsafe_apply_args = _safe_feedback_apply6_args(ctx, apply_chunk)
    unsafe_kernel = ctx.kernels.safe_feedback_apply_fn
    unsafe_label = 'unsafe-feedback-apply6'
    unsafe_block_x = ctx.args.channels
    inline_output_sums = _inline_first_pass_output_sums(ctx)
    if cfg.source_unsafe_skip_kernel and not inline_output_sums and cfg.source_exact_precompute and ctx.args.channels == 2:
        unsafe_kernel = ctx.kernels.safe_feedback_skip_apply_fn
        unsafe_label = 'unsafe-feedback-skip-parallel6'
        unsafe_block_x = 256
    elif cfg.exact_unsafe_skip_kernel_6ch and not inline_output_sums and ctx.args.channels == 6 and feedback_state_i_view(feedback_state_i_host).enabled('above_threshold'):
        unsafe_kernel = ctx.kernels.safe_feedback_skip_apply_fn
        unsafe_label = 'unsafe-feedback-skip-parallel6ch'
        unsafe_block_x = 256
    apply_dt = launch_apply_kernel(ctx, unsafe_label, unsafe_kernel, unsafe_apply_args, block_x=unsafe_block_x)
    result.apply_kernel_time += apply_dt
    result.exact_unsafe_kernel_time += apply_dt
    result.exact_unsafe_apply_kernel_time += apply_dt
    result.segmented_safe_feedback_profile.record_unsafe_apply(apply_dt, local_windows)


def _launch_direct_apply_kernel(ctx, result, apply_chunk, *, exact_chunk_unsafe):
    cfg = ctx.cfg
    apply_dt = launch_apply_kernel(ctx, 'apply', ctx.kernels.apply_fn, apply_chunk.apply_args, grid_x=apply_chunk.grid_samples, block_x=1 if cfg.exact_limiter_active else 256, check_label=f'cuLaunchKernel({apply_chunk.kernel_label})')
    result.apply_kernel_time += apply_dt
    if cfg.exact_limiter_active and exact_chunk_unsafe is not None:
        if exact_chunk_unsafe:
            result.exact_unsafe_kernel_time += apply_dt
            result.exact_unsafe_apply_kernel_time += apply_dt
        else:
            result.exact_safe_kernel_time += apply_dt
            result.exact_safe_apply_kernel_time += apply_dt


def launch_sync_apply_kernel(ctx, result, apply_chunk, feedback_state_i_host, *, exact_chunk_unsafe, frame_offset, exact_prefinal_frames):
    cfg = ctx.cfg
    mode = select_feedback_apply_mode(
        ctx,
        apply_chunk,
        feedback_state_i_host,
        exact_chunk_unsafe=exact_chunk_unsafe,
        frame_offset=frame_offset,
        exact_prefinal_frames=exact_prefinal_frames,
    )
    if mode.segmented_safe_chunk:
        local_windows = mode.local_windows
        if _launch_source_safe_run_scan_apply(ctx, result, apply_chunk, feedback_state_i_host, local_windows=local_windows):
            return
        if _launch_safe_run_scan_apply_6ch(ctx, result, apply_chunk, feedback_state_i_host, local_windows=local_windows):
            return
        if not _inline_first_pass_output_sums(ctx) and can_parallel_skip_safe_feedback(ctx, apply_chunk, feedback_state_i_host):
            state = feedback_state_i_view(feedback_state_i_host)
            frame_specialized = (
                (getattr(cfg, 'exact_safe_skip_apply_frame_kernel', False) or getattr(cfg, 'exact_skip_apply_rolling_ring_6ch', False))
                and state.enabled('above_threshold')
                and ctx.args.channels in (2, 6)
                and ctx.args.output_format == 'f64le'
            )
            skip_lookahead_scan_6ch = (
                ctx.args.channels == 6
                and state.enabled('above_threshold')
                and state.get('limiter_maybe_above_ceiling') == 0
                and state.get('limiter_state') == 0
            )
            skip_fill_peak_scan_6ch = skip_lookahead_scan_6ch and env_flag('LOUDNORM_GPU_SAFE_SKIP_6CH_SKIP_FILL_PEAK_SCAN')
            skip_apply_args = _safe_feedback_apply6_args(ctx, apply_chunk, frame_specialized=frame_specialized, skip_lookahead_scan_6ch=skip_lookahead_scan_6ch, skip_fill_peak_scan_6ch=skip_fill_peak_scan_6ch)
            label = 'safe-feedback-skip-frame6' if frame_specialized else 'safe-feedback-skip-parallel6'
            apply_dt = launch_apply_kernel(ctx, label, ctx.kernels.safe_feedback_skip_apply_fn, skip_apply_args, block_x=256)
            result.apply_kernel_time += apply_dt
            result.exact_safe_kernel_time += apply_dt
            result.exact_safe_apply_kernel_time += apply_dt
            result.segmented_safe_feedback_profile.record_parallel_skip(apply_dt, local_windows)
            return
        if can_prefix_skip_safe_feedback(ctx, apply_chunk, feedback_state_i_host):
            _launch_prefix_safe_feedback(ctx, result, apply_chunk, feedback_state_i_host, local_windows=local_windows)
            return
        if cfg.source_exact_precompute:
            result.segmented_safe_feedback_profile.record_fallback()
        else:
            safe_apply_args = _safe_feedback_apply6_args(ctx, apply_chunk)
            apply_dt = launch_apply_kernel(ctx, 'safe-feedback-apply6', ctx.kernels.safe_feedback_apply_fn, safe_apply_args, block_x=ctx.args.channels)
            result.apply_kernel_time += apply_dt
            result.exact_safe_kernel_time += apply_dt
            result.exact_safe_apply_kernel_time += apply_dt
            result.segmented_safe_feedback_profile.record_apply(apply_dt, local_windows)
            return

    if mode.parallel_unsafe:
        _launch_parallel_unsafe_feedback(ctx, result, apply_chunk, feedback_state_i_host, local_windows=mode.local_windows)
        return

    if mode.segmented_safe_fallback:
        result.segmented_safe_feedback_profile.record_fallback()
    _launch_direct_apply_kernel(ctx, result, apply_chunk, exact_chunk_unsafe=exact_chunk_unsafe)
