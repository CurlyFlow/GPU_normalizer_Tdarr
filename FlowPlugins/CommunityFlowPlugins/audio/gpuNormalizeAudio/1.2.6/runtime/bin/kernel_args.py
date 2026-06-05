from __future__ import annotations

import ctypes

from cuda_driver import ptr_arg


def build_exact_sums_args(in_arg, sums_arg, exact_sums_state_i_arg, exact_sums_state_d_arg, frames_arg, channels_arg, frame_window_arg, b_arg, a_arg):
    return (ctypes.c_void_p * 9)(ptr_arg(in_arg), ptr_arg(sums_arg), ptr_arg(exact_sums_state_i_arg), ptr_arg(exact_sums_state_d_arg), ptr_arg(frames_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(b_arg), ptr_arg(a_arg))


def build_channel_stats_args(in_arg, channel_sums_arg, peaks_arg, q_states_arg, source_start_states_arg, frames_arg, channels_arg, frame_window_arg, frame_offset_arg, b_arg, a_arg):
    return (ctypes.c_void_p * 11)(ptr_arg(in_arg), ptr_arg(channel_sums_arg), ptr_arg(peaks_arg), ptr_arg(q_states_arg), ptr_arg(source_start_states_arg), ptr_arg(frames_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(frame_offset_arg), ptr_arg(b_arg), ptr_arg(a_arg))


def build_channel_stats_source_energy_args(in_arg, channel_sums_arg, peaks_arg, q_states_arg, source_start_states_arg, source_energy_arg, source_energy_base_frame_arg, source_energy_frames_arg, frames_arg, channels_arg, frame_window_arg, frame_offset_arg, b_arg, a_arg):
    return (ctypes.c_void_p * 14)(ptr_arg(in_arg), ptr_arg(channel_sums_arg), ptr_arg(peaks_arg), ptr_arg(q_states_arg), ptr_arg(source_start_states_arg), ptr_arg(source_energy_arg), ptr_arg(source_energy_base_frame_arg), ptr_arg(source_energy_frames_arg), ptr_arg(frames_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(frame_offset_arg), ptr_arg(b_arg), ptr_arg(a_arg))


def build_channel_checkpoint_args(in_arg, peaks_arg, states_arg, checkpoint_states_arg, source_start_states_arg, frames_arg, channels_arg, frame_window_arg, frame_offset_arg, a_arg):
    return (ctypes.c_void_p * 10)(ptr_arg(in_arg), ptr_arg(peaks_arg), ptr_arg(states_arg), ptr_arg(checkpoint_states_arg), ptr_arg(source_start_states_arg), ptr_arg(frames_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(frame_offset_arg), ptr_arg(a_arg))


def build_peak_args(in_arg, peaks_arg, frames_arg, channels_arg, frame_window_arg, frame_offset_arg):
    return (ctypes.c_void_p * 6)(ptr_arg(in_arg), ptr_arg(peaks_arg), ptr_arg(frames_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(frame_offset_arg))


def build_channel_stats_offset_args(in_arg, channel_sums_arg, peaks_arg, q_states_arg, source_start_states_arg, frames_arg, channels_arg, input_channels_arg, channel_offset_arg, frame_window_arg, frame_offset_arg, b_arg, a_arg):
    return (ctypes.c_void_p * 13)(ptr_arg(in_arg), ptr_arg(channel_sums_arg), ptr_arg(peaks_arg), ptr_arg(q_states_arg), ptr_arg(source_start_states_arg), ptr_arg(frames_arg), ptr_arg(channels_arg), ptr_arg(input_channels_arg), ptr_arg(channel_offset_arg), ptr_arg(frame_window_arg), ptr_arg(frame_offset_arg), ptr_arg(b_arg), ptr_arg(a_arg))


def build_peak_offset_args(in_arg, peaks_arg, frames_arg, channels_arg, input_channels_arg, channel_offset_arg, frame_window_arg, frame_offset_arg):
    return (ctypes.c_void_p * 8)(ptr_arg(in_arg), ptr_arg(peaks_arg), ptr_arg(frames_arg), ptr_arg(channels_arg), ptr_arg(input_channels_arg), ptr_arg(channel_offset_arg), ptr_arg(frame_window_arg), ptr_arg(frame_offset_arg))


def build_compact_offset_args(in_arg, out_arg, frames_arg, channels_arg, input_channels_arg, channel_offset_arg, output_base_frame_arg, output_frames_arg, frame_offset_arg):
    return (ctypes.c_void_p * 9)(ptr_arg(in_arg), ptr_arg(out_arg), ptr_arg(frames_arg), ptr_arg(channels_arg), ptr_arg(input_channels_arg), ptr_arg(channel_offset_arg), ptr_arg(output_base_frame_arg), ptr_arg(output_frames_arg), ptr_arg(frame_offset_arg))


def build_paired_combined_channel_stats_args(in_arg, primary_channel_sums_arg, primary_peaks_arg, primary_states_arg, primary_source_start_states_arg, partner_channel_sums_arg, partner_peaks_arg, partner_states_arg, partner_source_start_states_arg, frames_arg, primary_channels_arg, partner_channels_arg, input_channels_arg, partner_channel_offset_arg, frame_window_arg, frame_offset_arg, b_arg, a_arg):
    return (ctypes.c_void_p * 18)(ptr_arg(in_arg), ptr_arg(primary_channel_sums_arg), ptr_arg(primary_peaks_arg), ptr_arg(primary_states_arg), ptr_arg(primary_source_start_states_arg), ptr_arg(partner_channel_sums_arg), ptr_arg(partner_peaks_arg), ptr_arg(partner_states_arg), ptr_arg(partner_source_start_states_arg), ptr_arg(frames_arg), ptr_arg(primary_channels_arg), ptr_arg(partner_channels_arg), ptr_arg(input_channels_arg), ptr_arg(partner_channel_offset_arg), ptr_arg(frame_window_arg), ptr_arg(frame_offset_arg), ptr_arg(b_arg), ptr_arg(a_arg))


def build_combine_sums_args(source_sums_arg, sums_arg, combine_windows_arg, channels_arg):
    return (ctypes.c_void_p * 4)(ptr_arg(source_sums_arg), ptr_arg(sums_arg), ptr_arg(combine_windows_arg), ptr_arg(channels_arg))


def build_source_exact_sums_args(in_arg, source_exact_sums_arg, source_start_states_arg, total_frames_arg, input_base_arg, input_frames_arg, target_start_window_arg, target_windows_arg, channels_arg, frame_window_arg, windows_arg, b_arg, a_arg):
    return (ctypes.c_void_p * 13)(ptr_arg(in_arg), ptr_arg(source_exact_sums_arg), ptr_arg(source_start_states_arg), ptr_arg(total_frames_arg), ptr_arg(input_base_arg), ptr_arg(input_frames_arg), ptr_arg(target_start_window_arg), ptr_arg(target_windows_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(windows_arg), ptr_arg(b_arg), ptr_arg(a_arg))


def build_source_exact_from_channel_sums_args(channel_sums_arg, source_exact_sums_arg, windows_arg, channels_arg, write_hist4_arg, write_short_arg):
    return (ctypes.c_void_p * 6)(ptr_arg(channel_sums_arg), ptr_arg(source_exact_sums_arg), ptr_arg(windows_arg), ptr_arg(channels_arg), ptr_arg(write_hist4_arg), ptr_arg(write_short_arg))


def build_source_energy_args(in_arg, source_energy_arg, source_start_states_arg, total_frames_arg, input_base_arg, input_frames_arg, channels_arg, frame_window_arg, b_arg, a_arg):
    return (ctypes.c_void_p * 10)(ptr_arg(in_arg), ptr_arg(source_energy_arg), ptr_arg(source_start_states_arg), ptr_arg(total_frames_arg), ptr_arg(input_base_arg), ptr_arg(input_frames_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(b_arg), ptr_arg(a_arg))


def build_source_exact_hist4_sums_args(source_energy_arg, source_exact_sums_arg, channel_sums_arg, hist_boundaries_arg, total_frames_arg, input_base_arg, input_frames_arg, target_start_window_arg, target_windows_arg, channels_arg, frame_window_arg, windows_arg, boundary_margin_ratio_arg, selective_boundary_arg):
    return (ctypes.c_void_p * 14)(ptr_arg(source_energy_arg), ptr_arg(source_exact_sums_arg), ptr_arg(channel_sums_arg), ptr_arg(hist_boundaries_arg), ptr_arg(total_frames_arg), ptr_arg(input_base_arg), ptr_arg(input_frames_arg), ptr_arg(target_start_window_arg), ptr_arg(target_windows_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(windows_arg), ptr_arg(boundary_margin_ratio_arg), ptr_arg(selective_boundary_arg))


def build_source_exact_short_sums_args(source_energy_arg, source_exact_sums_arg, total_frames_arg, input_base_arg, input_frames_arg, target_start_window_arg, target_windows_arg, channels_arg, frame_window_arg, windows_arg):
    return (ctypes.c_void_p * 10)(ptr_arg(source_energy_arg), ptr_arg(source_exact_sums_arg), ptr_arg(total_frames_arg), ptr_arg(input_base_arg), ptr_arg(input_frames_arg), ptr_arg(target_start_window_arg), ptr_arg(target_windows_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(windows_arg))


def build_source_selective_short_sums_args(source_energy_arg, source_exact_sums_arg, channel_sums_arg, hist_energies_arg, hist_boundaries_arg, total_frames_arg, input_base_arg, input_frames_arg, target_start_window_arg, target_windows_arg, channels_arg, frame_window_arg, windows_arg, measured_thresh_arg, margin_lu_arg, halo_windows_arg):
    return (ctypes.c_void_p * 16)(ptr_arg(source_energy_arg), ptr_arg(source_exact_sums_arg), ptr_arg(channel_sums_arg), ptr_arg(hist_energies_arg), ptr_arg(hist_boundaries_arg), ptr_arg(total_frames_arg), ptr_arg(input_base_arg), ptr_arg(input_frames_arg), ptr_arg(target_start_window_arg), ptr_arg(target_windows_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(windows_arg), ptr_arg(measured_thresh_arg), ptr_arg(margin_lu_arg), ptr_arg(halo_windows_arg))


def build_source_selective_short_raw_sums_args(in_arg, source_start_states_arg, source_exact_sums_arg, channel_sums_arg, hist_energies_arg, hist_boundaries_arg, total_frames_arg, input_base_arg, input_frames_arg, target_start_window_arg, target_windows_arg, channels_arg, frame_window_arg, windows_arg, b_arg, a_arg, measured_thresh_arg, margin_lu_arg, halo_windows_arg):
    return (ctypes.c_void_p * 19)(ptr_arg(in_arg), ptr_arg(source_start_states_arg), ptr_arg(source_exact_sums_arg), ptr_arg(channel_sums_arg), ptr_arg(hist_energies_arg), ptr_arg(hist_boundaries_arg), ptr_arg(total_frames_arg), ptr_arg(input_base_arg), ptr_arg(input_frames_arg), ptr_arg(target_start_window_arg), ptr_arg(target_windows_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(windows_arg), ptr_arg(b_arg), ptr_arg(a_arg), ptr_arg(measured_thresh_arg), ptr_arg(margin_lu_arg), ptr_arg(halo_windows_arg))


def build_source_mark_short_raw_corrections_args(source_exact_sums_arg, correction_flags_arg, channel_sums_arg, hist_energies_arg, hist_boundaries_arg, target_start_window_arg, target_windows_arg, channels_arg, frame_window_arg, windows_arg, measured_thresh_arg, margin_lu_arg, halo_windows_arg):
    return (ctypes.c_void_p * 13)(ptr_arg(source_exact_sums_arg), ptr_arg(correction_flags_arg), ptr_arg(channel_sums_arg), ptr_arg(hist_energies_arg), ptr_arg(hist_boundaries_arg), ptr_arg(target_start_window_arg), ptr_arg(target_windows_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(windows_arg), ptr_arg(measured_thresh_arg), ptr_arg(margin_lu_arg), ptr_arg(halo_windows_arg))


def build_source_apply_short_raw_corrections_args(in_arg, source_start_states_arg, source_exact_sums_arg, correction_flags_arg, total_frames_arg, input_base_arg, input_frames_arg, target_start_window_arg, target_windows_arg, channels_arg, frame_window_arg, windows_arg, b_arg, a_arg):
    return (ctypes.c_void_p * 14)(ptr_arg(in_arg), ptr_arg(source_start_states_arg), ptr_arg(source_exact_sums_arg), ptr_arg(correction_flags_arg), ptr_arg(total_frames_arg), ptr_arg(input_base_arg), ptr_arg(input_frames_arg), ptr_arg(target_start_window_arg), ptr_arg(target_windows_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(windows_arg), ptr_arg(b_arg), ptr_arg(a_arg))


def build_source_selective_hist4_sums_args(in_arg, source_start_states_arg, source_exact_sums_arg, channel_sums_arg, hist_boundaries_arg, total_frames_arg, input_base_arg, input_frames_arg, target_start_window_arg, target_windows_arg, channels_arg, frame_window_arg, windows_arg, b_arg, a_arg, boundary_margin_ratio_arg):
    return (ctypes.c_void_p * 16)(ptr_arg(in_arg), ptr_arg(source_start_states_arg), ptr_arg(source_exact_sums_arg), ptr_arg(channel_sums_arg), ptr_arg(hist_boundaries_arg), ptr_arg(total_frames_arg), ptr_arg(input_base_arg), ptr_arg(input_frames_arg), ptr_arg(target_start_window_arg), ptr_arg(target_windows_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(windows_arg), ptr_arg(b_arg), ptr_arg(a_arg), ptr_arg(boundary_margin_ratio_arg))


def build_source_block_sums_args(source_energy_arg, source_block_sums_arg, input_frames_arg, channels_arg, block_frames_arg):
    return (ctypes.c_void_p * 5)(ptr_arg(source_energy_arg), ptr_arg(source_block_sums_arg), ptr_arg(input_frames_arg), ptr_arg(channels_arg), ptr_arg(block_frames_arg))


def build_source_block_prefix_sums_args(source_block_sums_arg, block_count_arg, channels_arg):
    return (ctypes.c_void_p * 3)(ptr_arg(source_block_sums_arg), ptr_arg(block_count_arg), ptr_arg(channels_arg))


def build_source_block_exact_sums_args(source_energy_arg, source_block_sums_arg, source_exact_sums_arg, total_frames_arg, input_base_arg, input_frames_arg, target_start_window_arg, target_windows_arg, channels_arg, frame_window_arg, windows_arg, block_frames_arg):
    return (ctypes.c_void_p * 12)(ptr_arg(source_energy_arg), ptr_arg(source_block_sums_arg), ptr_arg(source_exact_sums_arg), ptr_arg(total_frames_arg), ptr_arg(input_base_arg), ptr_arg(input_frames_arg), ptr_arg(target_start_window_arg), ptr_arg(target_windows_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(windows_arg), ptr_arg(block_frames_arg))


def build_q_args(in_arg, q_states_arg, peaks_arg, frames_arg, channels_arg, frame_window_arg, window_offset_arg, a_arg):
    return (ctypes.c_void_p * 8)(ptr_arg(in_arg), ptr_arg(q_states_arg), ptr_arg(peaks_arg), ptr_arg(frames_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(window_offset_arg), ptr_arg(a_arg))


def build_sums_args(in_arg, sums_arg, start_states_arg, frames_arg, channels_arg, frame_window_arg, window_offset_arg, b_arg, a_arg):
    return (ctypes.c_void_p * 9)(ptr_arg(in_arg), ptr_arg(sums_arg), ptr_arg(start_states_arg), ptr_arg(frames_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(window_offset_arg), ptr_arg(b_arg), ptr_arg(a_arg))


def build_prefix_start_state_args(q_states_arg, start_states_arg, windows_arg, channels_arg, frame_window_arg, total_frames_arg, a_arg):
    return (ctypes.c_void_p * 7)(ptr_arg(q_states_arg), ptr_arg(start_states_arg), ptr_arg(windows_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(total_frames_arg), ptr_arg(a_arg))


def build_gain_args(sums_arg, peaks_arg, gains_arg, gains_next_arg, windows_arg, frame_window_arg, target_i_arg, target_lra_arg, target_tp_arg, hist_energies_arg, hist_boundaries_arg, measured_i_arg, measured_thresh_arg, offset_db_arg, linear_mode_arg):
    return (ctypes.c_void_p * 15)(ptr_arg(sums_arg), ptr_arg(peaks_arg), ptr_arg(gains_arg), ptr_arg(gains_next_arg), ptr_arg(windows_arg), ptr_arg(frame_window_arg), ptr_arg(target_i_arg), ptr_arg(target_lra_arg), ptr_arg(target_tp_arg), ptr_arg(hist_energies_arg), ptr_arg(hist_boundaries_arg), ptr_arg(measured_i_arg), ptr_arg(measured_thresh_arg), ptr_arg(offset_db_arg), ptr_arg(linear_mode_arg))


def build_metrics_args(sums_arg, gains_arg, metrics_arg, windows_arg, frame_window_arg, hist_energies_arg, hist_boundaries_arg):
    return (ctypes.c_void_p * 7)(ptr_arg(sums_arg), ptr_arg(gains_arg), ptr_arg(metrics_arg), ptr_arg(windows_arg), ptr_arg(frame_window_arg), ptr_arg(hist_energies_arg), ptr_arg(hist_boundaries_arg))


def build_apply_args(in_arg, out_arg, gains_arg, n_arg, channels_arg, frame_window_arg, windows_arg, offset_arg, ceiling_arg):
    return (ctypes.c_void_p * 9)(ptr_arg(in_arg), ptr_arg(out_arg), ptr_arg(gains_arg), ptr_arg(n_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(windows_arg), ptr_arg(offset_arg), ptr_arg(ceiling_arg))


def build_linear_apply_args(in_arg, out_arg, gain_arg, n_arg, ceiling_arg):
    return (ctypes.c_void_p * 5)(ptr_arg(in_arg), ptr_arg(out_arg), ptr_arg(gain_arg), ptr_arg(n_arg), ptr_arg(ceiling_arg))


def build_ffmpeg_timing_apply_args(in_arg, out_arg, gains_arg, gains_next_arg, n_arg, channels_arg, frame_window_arg, windows_arg, offset_arg, limiter_lookahead_arg, gain_timing_offset_arg, total_frames_arg, ceiling_arg, *, final_apply=False):
    if final_apply:
        return (ctypes.c_void_p * 13)(ptr_arg(in_arg), ptr_arg(out_arg), ptr_arg(gains_arg), ptr_arg(gains_next_arg), ptr_arg(n_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(windows_arg), ptr_arg(offset_arg), ptr_arg(limiter_lookahead_arg), ptr_arg(gain_timing_offset_arg), ptr_arg(total_frames_arg), ptr_arg(ceiling_arg))
    return (ctypes.c_void_p * 12)(ptr_arg(in_arg), ptr_arg(out_arg), ptr_arg(gains_arg), ptr_arg(gains_next_arg), ptr_arg(n_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(windows_arg), ptr_arg(offset_arg), ptr_arg(limiter_lookahead_arg), ptr_arg(gain_timing_offset_arg), ptr_arg(ceiling_arg))


def build_prefill_args(in_arg, out_arg, gains_arg, gains_next_arg, n_prefill_arg, channels_arg, frame_window_arg, windows_arg, output_offset_arg, input_base_arg, limiter_lookahead_arg, gain_timing_offset_arg, total_frames_arg, ceiling_arg):
    return (ctypes.c_void_p * 14)(ptr_arg(in_arg), ptr_arg(out_arg), ptr_arg(gains_arg), ptr_arg(gains_next_arg), ptr_arg(n_prefill_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg), ptr_arg(windows_arg), ptr_arg(output_offset_arg), ptr_arg(input_base_arg), ptr_arg(limiter_lookahead_arg), ptr_arg(gain_timing_offset_arg), ptr_arg(total_frames_arg), ptr_arg(ceiling_arg))


def build_exact_feedback_apply_args(in_arg, out_arg, sums_arg, source_channel_sums_arg, source_short_ring_arg, output_window_sums_arg, hist_energies_arg, hist_boundaries_arg, limiter_buf_arg, limiter_prev_arg, feedback_state_i_arg, feedback_state_d_arg, feedback_hist_arg, total_frames_arg, input_base_arg, input_frames_arg, output_frames_arg, channels_arg, frame_window_arg, windows_arg, limiter_lookahead_arg, attack_length_arg, release_length_arg, b_arg, a_arg, exact_target_i_arg, exact_target_lra_arg, exact_measured_i_arg, exact_measured_thresh_arg, exact_offset_amp_arg, exact_limiter_ceiling_arg, source_faithful_stereo_arg):
    return (ctypes.c_void_p * 32)(
        ptr_arg(in_arg), ptr_arg(out_arg), ptr_arg(sums_arg), ptr_arg(source_channel_sums_arg),
        ptr_arg(source_short_ring_arg), ptr_arg(output_window_sums_arg), ptr_arg(hist_energies_arg), ptr_arg(hist_boundaries_arg), ptr_arg(limiter_buf_arg),
        ptr_arg(limiter_prev_arg), ptr_arg(feedback_state_i_arg), ptr_arg(feedback_state_d_arg),
        ptr_arg(feedback_hist_arg), ptr_arg(total_frames_arg), ptr_arg(input_base_arg),
        ptr_arg(input_frames_arg), ptr_arg(output_frames_arg), ptr_arg(channels_arg),
        ptr_arg(frame_window_arg), ptr_arg(windows_arg), ptr_arg(limiter_lookahead_arg),
        ptr_arg(attack_length_arg), ptr_arg(release_length_arg), ptr_arg(b_arg), ptr_arg(a_arg),
        ptr_arg(exact_target_i_arg), ptr_arg(exact_target_lra_arg), ptr_arg(exact_measured_i_arg),
        ptr_arg(exact_measured_thresh_arg), ptr_arg(exact_offset_amp_arg),
        ptr_arg(exact_limiter_ceiling_arg), ptr_arg(source_faithful_stereo_arg),
    )


def build_safe_feedback_apply6_args(in_arg, out_arg, sums_arg, hist_energies_arg, hist_boundaries_arg, limiter_buf_arg, limiter_prev_arg, feedback_state_i_arg, feedback_state_d_arg, feedback_hist_arg, safe_feedback_frames_arg, total_frames_arg, input_base_arg, input_frames_arg, frames_arg, channels_arg, frame_window_arg, windows_arg, limiter_lookahead_arg, attack_length_arg, release_length_arg, b_arg, a_arg, exact_target_i_arg, exact_target_lra_arg, exact_measured_i_arg, exact_measured_thresh_arg, exact_offset_amp_arg, exact_limiter_ceiling_arg, source_channel_sums_arg=None, output_window_sums_arg=None, source_faithful_stereo_arg=None):
    if source_channel_sums_arg is None:
        source_channel_sums_arg = ctypes.c_uint64(0)
    if output_window_sums_arg is None:
        output_window_sums_arg = ctypes.c_uint64(0)
    if source_faithful_stereo_arg is None:
        source_faithful_stereo_arg = ctypes.c_uint32(0)
    return (ctypes.c_void_p * 32)(
        ptr_arg(in_arg), ptr_arg(out_arg), ptr_arg(sums_arg), ptr_arg(hist_energies_arg),
        ptr_arg(hist_boundaries_arg), ptr_arg(limiter_buf_arg), ptr_arg(limiter_prev_arg),
        ptr_arg(feedback_state_i_arg), ptr_arg(feedback_state_d_arg), ptr_arg(feedback_hist_arg),
        ptr_arg(safe_feedback_frames_arg), ptr_arg(total_frames_arg), ptr_arg(input_base_arg),
        ptr_arg(input_frames_arg), ptr_arg(frames_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg),
        ptr_arg(windows_arg), ptr_arg(limiter_lookahead_arg), ptr_arg(attack_length_arg),
        ptr_arg(release_length_arg), ptr_arg(b_arg), ptr_arg(a_arg), ptr_arg(exact_target_i_arg),
        ptr_arg(exact_target_lra_arg), ptr_arg(exact_measured_i_arg),
        ptr_arg(exact_measured_thresh_arg), ptr_arg(exact_offset_amp_arg), ptr_arg(exact_limiter_ceiling_arg),
        ptr_arg(source_channel_sums_arg), ptr_arg(output_window_sums_arg), ptr_arg(source_faithful_stereo_arg),
    )


def build_safe_feedback_energy_args(out_arg, safe_feedback_frames_arg, feedback_state_d_arg, frames_arg, channels_arg, b_arg, a_arg):
    return (ctypes.c_void_p * 7)(
        ptr_arg(out_arg), ptr_arg(safe_feedback_frames_arg), ptr_arg(feedback_state_d_arg),
        ptr_arg(frames_arg), ptr_arg(channels_arg), ptr_arg(b_arg), ptr_arg(a_arg),
    )


def build_safe_feedback_window_args(safe_feedback_frames_arg, feedback_window_sums_arg, frames_arg, frame_window_arg):
    return (ctypes.c_void_p * 4)(
        ptr_arg(safe_feedback_frames_arg), ptr_arg(feedback_window_sums_arg),
        ptr_arg(frames_arg), ptr_arg(frame_window_arg),
    )


def build_safe_feedback_output_state_args(feedback_state_i_arg, feedback_state_d_arg, feedback_window_sums_arg, local_windows_arg, frame_window_arg):
    return (ctypes.c_void_p * 5)(
        ptr_arg(feedback_state_i_arg), ptr_arg(feedback_state_d_arg),
        ptr_arg(feedback_window_sums_arg), ptr_arg(local_windows_arg), ptr_arg(frame_window_arg),
    )


def build_safe_feedback_stitch_args(feedback_state_i_arg, feedback_state_d_arg, feedback_hist_arg, out_arg, limiter_prev_arg, input_window_sums_arg, feedback_window_sums_arg, hist_energies_arg, hist_boundaries_arg, local_windows_arg, total_frames_arg, channels_arg, frame_window_arg, windows_arg, limiter_lookahead_arg, exact_target_i_arg, exact_target_lra_arg, exact_measured_i_arg, exact_measured_thresh_arg, exact_limiter_ceiling_arg, fill_gain_pairs_arg, fill_gain_lead_arg, fill_gain_count_arg, source_faithful_stereo_arg):
    return (ctypes.c_void_p * 24)(
        ptr_arg(feedback_state_i_arg), ptr_arg(feedback_state_d_arg), ptr_arg(feedback_hist_arg),
        ptr_arg(out_arg), ptr_arg(limiter_prev_arg), ptr_arg(input_window_sums_arg),
        ptr_arg(feedback_window_sums_arg), ptr_arg(hist_energies_arg), ptr_arg(hist_boundaries_arg),
        ptr_arg(local_windows_arg), ptr_arg(total_frames_arg), ptr_arg(channels_arg),
        ptr_arg(frame_window_arg), ptr_arg(windows_arg), ptr_arg(limiter_lookahead_arg),
        ptr_arg(exact_target_i_arg), ptr_arg(exact_target_lra_arg), ptr_arg(exact_measured_i_arg),
        ptr_arg(exact_measured_thresh_arg), ptr_arg(exact_limiter_ceiling_arg), ptr_arg(fill_gain_pairs_arg),
        ptr_arg(fill_gain_lead_arg), ptr_arg(fill_gain_count_arg), ptr_arg(source_faithful_stereo_arg),
    )


def build_safe_feedback_fill_args(in_arg, out_arg, limiter_buf_arg, limiter_prev_arg, fill_gain_pairs_arg, samples_arg, output_frames_arg, channels_arg, frame_window_arg, limiter_lookahead_arg, output_frame_arg, input_base_arg, input_frames_arg, write_frame_arg, fill_gain_lead_arg, fill_gain_count_arg, exact_offset_amp_arg, exact_limiter_ceiling_arg):
    return (ctypes.c_void_p * 18)(
        ptr_arg(in_arg), ptr_arg(out_arg), ptr_arg(limiter_buf_arg), ptr_arg(limiter_prev_arg), ptr_arg(fill_gain_pairs_arg),
        ptr_arg(samples_arg), ptr_arg(output_frames_arg), ptr_arg(channels_arg), ptr_arg(frame_window_arg),
        ptr_arg(limiter_lookahead_arg), ptr_arg(output_frame_arg), ptr_arg(input_base_arg),
        ptr_arg(input_frames_arg), ptr_arg(write_frame_arg), ptr_arg(fill_gain_lead_arg),
        ptr_arg(fill_gain_count_arg), ptr_arg(exact_offset_amp_arg), ptr_arg(exact_limiter_ceiling_arg),
    )
