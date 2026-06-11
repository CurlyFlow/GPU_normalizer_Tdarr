from __future__ import annotations

from dataclasses import dataclass
import sys

from loudnorm_math import amp_to_db


@dataclass
class SegmentedSafeFeedbackProfile:
    energy_time: float = 0.0
    window_time: float = 0.0
    stitch_time: float = 0.0
    apply_time: float = 0.0
    unsafe_apply_time: float = 0.0
    parallel_skip_time: float = 0.0
    chunks: int = 0
    unsafe_chunks: int = 0
    parallel_skip_chunks: int = 0
    windows: int = 0
    fallback_chunks: int = 0

    def record_apply(self, seconds, windows):
        self.apply_time += seconds
        self.chunks += 1
        self.windows += windows

    def record_prefix(self, energy_seconds, window_seconds, stitch_seconds, windows):
        self.energy_time += energy_seconds
        self.window_time += window_seconds
        self.stitch_time += stitch_seconds
        self.apply_time += energy_seconds + window_seconds + stitch_seconds
        self.chunks += 1
        self.windows += windows

    def record_unsafe_apply(self, seconds, windows):
        self.unsafe_apply_time += seconds
        self.unsafe_chunks += 1
        self.windows += windows

    def record_parallel_skip(self, seconds, windows):
        self.apply_time += seconds
        self.parallel_skip_time += seconds
        self.chunks += 1
        self.parallel_skip_chunks += 1
        self.windows += windows

    def record_fallback(self):
        self.fallback_chunks += 1


def format_profile_stage(name, fields):
    parts = [f'profile_stage name={name}']
    parts.extend(f'{key}={value}' for key, value in fields)
    return ' '.join(parts)


def flag(value):
    return 1 if value else 0


def emit_profile_stage(name, fields):
    print(format_profile_stage(name, fields), file=sys.stderr)


def source_mode_for(cfg):
    if cfg.source_exact_precompute:
        return 'stereo_fallback_source_precompute'
    if cfg.source_faithful_stereo:
        return 'stereo_fallback_source_exact'
    return 'default'


def runtime_audio_summary_fields(args, cfg):
    return [
        ('audio_seconds', f'{cfg.seconds:.3f}'),
        ('rate', args.rate),
        ('channels', args.channels),
        ('windows', cfg.windows),
        ('pcm_mib', f'{cfg.mib:.1f}'),
        ('chunk_mib', f'{cfg.chunk_bytes/(1024*1024):.1f}'),
        ('safe_skip_chunk_mib', f'{getattr(cfg, "exact_safe_skip_chunk_bytes", 0)/(1024*1024):.1f}'),
        ('stats_chunk_mib', f'{cfg.stats_chunk_bytes/(1024*1024):.1f}'),
        ('input_format', args.input_format),
        ('output_format', args.output_format),
        ('streaming_io', flag(cfg.streaming_io)),
        ('source_mode', source_mode_for(cfg)),
        ('source_precompute_windows', cfg.source_precompute_windows),
        ('source_precompute_from_channel_sums', flag(cfg.source_precompute_from_channel_sums)),
        ('source_channel_hist4_exact', flag(cfg.source_channel_hist4_exact)),
        ('source_channel_hist4_boundary', flag(cfg.source_channel_hist4_boundary)),
        ('source_channel_short_exact', flag(cfg.source_channel_short_exact)),
        ('source_channel_short_boundary', flag(cfg.source_channel_short_boundary)),
        ('source_channel_short_raw_boundary', flag(getattr(cfg, 'source_channel_short_raw_boundary', False))),
        ('source_channel_short_margin_lu', f'{cfg.source_channel_short_margin_lu:.6g}'),
        ('source_channel_short_halo_windows', cfg.source_channel_short_halo_windows),
        ('source_channel_hist4_margin_lu', f'{cfg.source_channel_hist4_margin_lu:.6g}'),
        ('source_precompute_in_stats', flag(cfg.source_precompute_in_stats)),
        ('source_precompute_device_energy', flag(cfg.source_precompute_device_energy)),
        ('source_precompute_device_input', flag(getattr(cfg, 'source_precompute_device_input', False))),
        ('source_energy_packed', flag(cfg.source_energy_packed)),
        ('source_block_sums', flag(cfg.source_block_sums)),
        ('source_block_frames', cfg.source_block_frames),
        ('source_block_exact_after_window', cfg.source_block_exact_after_window),
        ('source_block_exact_until_window', cfg.source_block_exact_until_window),
        ('source_sum_audit', flag(cfg.source_sum_audit)),
    ]


def stats_exact_mode_for(args, cfg):
    if cfg.exact_stats_stream:
        return 'stream_f64'
    if cfg.exact_prefix_channel_stats:
        return 'prefix_channel_f64'
    if cfg.exact_limiter_active and args.input_format == 'f64le':
        return 'channel_stream_f64'
    if args.input_format == 'f64le':
        return 'parallel_f64'
    return 'parallel_f32'


def stats_sums_fields(args, cfg, stats_result):
    return [
        ('wall_sec', f'{stats_result.stats_sums_wall_time:.6f}'),
        ('h2d_sec', f'{stats_result.stats_sums_h2d_time:.6f}'),
        ('kernel_sec', f'{stats_result.stats_sums_kernel_time:.6f}'),
        ('exact_mode', stats_exact_mode_for(args, cfg)),
        ('fast_launch', flag(cfg.exact_stats_fast_launch)),
        ('async_pipeline', flag(cfg.exact_stats_async_pipeline)),
        ('async_pinned_pipeline', flag(cfg.exact_stats_async_pinned_pipeline)),
        ('async_parallel_peaks', flag(cfg.exact_stats_async_parallel_peaks)),
        ('prefetch_pinned_async_h2d', flag(cfg.stats_prefetch_pinned_async_h2d)),
        ('prefetch_pinned_async_buffers', cfg.stats_prefetch_pinned_async_buffers),
        ('checkpoint_replay', flag(cfg.exact_channel_stats_checkpoint_replay)),
        ('channel_warp', flag(cfg.exact_channel_stats_warp)),
        ('channel_no_peaks', flag(cfg.exact_channel_stats_no_peaks)),
        ('channel_unroll4', flag(cfg.exact_channel_stats_unroll4)),
        ('channel_cpu_native', flag(cfg.exact_channel_stats_cpu_native)),
        ('paired_fused_kernel', flag(cfg.exact_paired_stats_fused_kernel)),
    ]


def source_precompute_fields(stats_result):
    return [
        ('stages', stats_result.source_precompute_stages),
        ('wall_sec', f'{stats_result.source_precompute_wall_time:.6f}'),
        ('h2d_sec', f'{stats_result.source_precompute_h2d_time:.6f}'),
        ('energy_kernel_sec', f'{stats_result.source_precompute_energy_kernel_time:.6f}'),
        ('exact_kernel_sec', f'{stats_result.source_precompute_exact_kernel_time:.6f}'),
        ('hist4_kernel_sec', f'{stats_result.source_precompute_hist4_kernel_time:.6f}'),
        ('block_sums_kernel_sec', f'{stats_result.source_precompute_block_sums_kernel_time:.6f}'),
        ('block_prefix_kernel_sec', f'{stats_result.source_precompute_block_prefix_kernel_time:.6f}'),
        ('block_exact_kernel_sec', f'{stats_result.source_precompute_block_exact_kernel_time:.6f}'),
    ]


def apply_profile_fields(args, cfg, apply_result, bindings):
    segmented = apply_result.segmented_safe_feedback_profile
    return [
        ('wall_sec', f'{apply_result.apply_wall_time:.6f}'),
        ('h2d_sec', f'{apply_result.apply_h2d_time:.6f}'),
        ('kernel_sec', f'{apply_result.apply_kernel_time:.6f}'),
        ('d2h_sec', f'{apply_result.apply_d2h_time:.6f}'),
        ('write_sec', f'{apply_result.apply_write_time:.6f}'),
        ('async_write', apply_result.apply_async_write),
        ('async_write_worker_sec', f'{apply_result.apply_async_write_worker_time:.6f}'),
        ('async_write_close_wait_sec', f'{apply_result.apply_async_write_close_wait_time:.6f}'),
        ('async_write_peak_queue', apply_result.apply_async_write_peak_queue),
        ('async_write_borrowed_writes', apply_result.apply_async_write_borrowed_writes),
        ('async_write_borrowed_mib', f'{apply_result.apply_async_write_borrowed_bytes/(1024*1024):.3f}'),
        ('async_write_cuda_event_writes', apply_result.apply_async_write_cuda_event_writes),
        ('async_write_cuda_event_wait_sec', f'{apply_result.apply_async_write_cuda_event_wait_time:.6f}'),
        ('async_output_borrow_wait_sec', f'{apply_result.apply_async_output_borrow_wait_time:.6f}'),
        ('async_output_borrowed_writes', apply_result.apply_async_output_borrowed_writes),
        ('async_output_borrowed_mib', f'{apply_result.apply_async_output_borrowed_bytes/(1024*1024):.3f}'),
        ('async_output_borrowed_peak_slots', apply_result.apply_async_output_borrowed_peak_slots),
        ('first_pass_output_metric_kernel_sec', f'{apply_result.first_pass_output_metric_kernel_time:.6f}'),
        ('path', apply_result.apply_path),
        ('pinned', apply_result.apply_pinned),
        ('streams', apply_result.apply_stream_count),
        ('fallback', apply_result.apply_async_fallback),
        ('input_format', args.input_format),
        ('output_format', args.output_format),
        ('encode_pipe_f32', flag(getattr(cfg, 'encode_pipe_f32', False))),
        ('ffmpeg_timing', flag(cfg.apply_ffmpeg_timing)),
        ('ffmpeg_limiter', flag(cfg.exact_limiter_requested)),
        ('ffmpeg_final_flush', flag(cfg.exact_limiter_requested)),
        ('parallel_final_apply', flag(cfg.parallel_final_apply)),
        ('exact_prefill_output', flag(cfg.exact_prefill_output)),
        ('exact_use_prefilled_output', flag(cfg.exact_use_prefilled_output)),
        ('exact_sparse_chunks', flag(cfg.exact_sparse_chunks)),
        ('exact_skip_safe_fill', flag(cfg.exact_skip_safe_fill)),
        ('exact_skip_safe_feedback', flag(cfg.exact_skip_safe_feedback)),
        ('exact_force_safe_idle', flag(cfg.exact_force_safe_idle)),
        ('exact_segmented_safe_feedback', flag(cfg.exact_segmented_safe_feedback)),
        ('exact_safe_feedback_prefix', flag(cfg.exact_safe_feedback_prefix)),
        ('exact_safe_feedback_prefix_post_fill', flag(getattr(cfg, 'exact_safe_feedback_prefix_post_fill', False))),
        ('exact_safe_feedback_window_accum', flag(cfg.exact_safe_feedback_window_accum)),
        ('exact_safe_feedback_slot_accum', flag(cfg.exact_safe_feedback_slot_accum)),
        ('exact_parallel_unsafe_feedback', flag(cfg.exact_parallel_unsafe_feedback)),
        ('exact_skip_unsafe_feedback', flag(cfg.exact_skip_unsafe_feedback)),
        ('exact_unsafe_skip_kernel_6ch', flag(cfg.exact_unsafe_skip_kernel_6ch)),
        ('exact_parallel_skip_safe_feedback', flag(cfg.exact_parallel_skip_safe_feedback)),
        ('exact_safe_skip_apply_frame_kernel', flag(getattr(cfg, 'exact_safe_skip_apply_frame_kernel', False))),
        ('source_parallel_skip_before_threshold', flag(cfg.source_parallel_skip_before_threshold)),
        ('source_unsafe_skip_kernel', flag(cfg.source_unsafe_skip_kernel)),
        ('source_skip_limiter_lookahead_scan', flag(cfg.source_skip_limiter_lookahead_scan)),
        ('source_fused_direct_feedback', flag(cfg.source_fused_direct_feedback)),
        ('source_safe_run_scan_apply', flag(cfg.source_safe_run_scan_apply)),
        ('exact_safe_run_scan_apply_6ch', flag(cfg.exact_safe_run_scan_apply_6ch)),
        ('exact_safe_run_scan_apply_6ch_boundary_halo_windows', getattr(cfg, 'exact_safe_run_scan_apply_6ch_boundary_halo_windows', 0)),
        ('exact_safe_run_scan_apply_post_fill', flag(getattr(cfg, 'exact_safe_run_scan_apply_post_fill', False))),
        ('exact_use_risk_map', flag(cfg.exact_use_risk_map)),
        ('source_faithful_stereo', flag(cfg.source_faithful_stereo)),
        ('source_exact_precompute', flag(cfg.source_exact_precompute)),
        ('source_precompute_in_stats', flag(cfg.source_precompute_in_stats)),
        ('exact_channel_stats_combined_peaks', flag(cfg.exact_channel_stats_combined_peaks)),
        ('exact_channel_stats_no_peaks', flag(cfg.exact_channel_stats_no_peaks)),
        ('exact_stats_parallel_peaks', flag(cfg.exact_stats_parallel_peaks)),
        ('skip_safe_fill_margin_frames', cfg.exact_skip_safe_fill_margin_frames),
        ('skip_safe_fill_chunks', apply_result.exact_skip_safe_fill_chunks),
        ('sparse_chunk_splits', apply_result.exact_sparse_chunk_splits),
        ('risk_gate_safe_chunks', apply_result.exact_risk_gate_safe_chunks),
        ('risk_gate_total_chunks', apply_result.exact_risk_gate_total_chunks),
        ('safe_chunks', apply_result.exact_safe_chunks),
        ('unsafe_chunks', apply_result.exact_unsafe_chunks),
        ('safe_kernel_sec', f'{apply_result.exact_safe_kernel_time:.6f}'),
        ('unsafe_kernel_sec', f'{apply_result.exact_unsafe_kernel_time:.6f}'),
        ('prefill_kernel_sec', f'{apply_result.exact_prefill_kernel_time:.6f}'),
        ('safe_apply_kernel_sec', f'{apply_result.exact_safe_apply_kernel_time:.6f}'),
        ('unsafe_apply_kernel_sec', f'{apply_result.exact_unsafe_apply_kernel_time:.6f}'),
        ('segmented_safe_feedback_chunks', segmented.chunks),
        ('parallel_unsafe_feedback_chunks', segmented.unsafe_chunks),
        ('parallel_skip_safe_feedback_chunks', segmented.parallel_skip_chunks),
        ('segmented_safe_feedback_windows', segmented.windows),
        ('segmented_safe_feedback_fallback_chunks', segmented.fallback_chunks),
        ('segmented_safe_feedback_apply_sec', f'{segmented.apply_time:.6f}'),
        ('parallel_unsafe_feedback_apply_sec', f'{segmented.unsafe_apply_time:.6f}'),
        ('parallel_skip_safe_feedback_apply_sec', f'{segmented.parallel_skip_time:.6f}'),
        ('segmented_safe_feedback_energy_sec', f'{segmented.energy_time:.6f}'),
        ('segmented_safe_feedback_window_sec', f'{segmented.window_time:.6f}'),
        ('segmented_safe_feedback_stitch_sec', f'{segmented.stitch_time:.6f}'),
        ('ffmpeg_gain_offset_ms', f'{args.ffmpeg_gain_offset_ms:.3f}'),
        ('ffmpeg_gain_offset_frames', bindings.gain_timing_offset_arg.value),
    ]


def exact_apply_count_fields(exact_counts_host):
    return [
        ('enabled', 1),
        ('output_frames', f'{exact_counts_host[116]:.0f}'),
        ('input_reads', f'{exact_counts_host[117]:.0f}'),
        ('input_zeros', f'{exact_counts_host[118]:.0f}'),
        ('limiter_writes', f'{exact_counts_host[119]:.0f}'),
        ('limiter_scale_rw', f'{exact_counts_host[120]:.0f}'),
        ('output_writes', f'{exact_counts_host[121]:.0f}'),
        ('feedback_iir', f'{exact_counts_host[122]:.0f}'),
        ('short_ring_writes', f'{exact_counts_host[123]:.0f}'),
        ('detect_calls', f'{exact_counts_host[124]:.0f}'),
        ('detect_frames', f'{exact_counts_host[125]:.0f}'),
        ('detect_lookahead', f'{exact_counts_host[126]:.0f}'),
        ('peak_hits', f'{exact_counts_host[127]:.0f}'),
    ]


def emit_runtime_summary(args, cfg, *, gpu_name, elapsed, stats_result, gain_metrics, apply_result, bindings):
    print(f'gpu={gpu_name}', file=sys.stderr)
    print(' '.join(f'{key}={value}' for key, value in runtime_audio_summary_fields(args, cfg)), file=sys.stderr)
    print(f'target_i={args.target_i:.2f} target_lra={args.target_lra:.2f} target_tp={args.target_tp:.2f} effective_tp={cfg.effective_tp:.2f} max_gain_db={args.max_gain_db:.2f}', file=sys.stderr)
    if cfg.has_measured:
        print(f'cpu_loudnorm_first_pass measured_i={args.measured_i:.2f} measured_lra={args.measured_lra:.2f} measured_tp={args.measured_tp:.2f} measured_thresh={args.measured_thresh:.2f} offset_db={cfg.runtime_offset_db:.2f} linear_mode={flag(cfg.linear_mode)}', file=sys.stderr)
    print(f'planner=cuda_source_port_ebur128_delta gain_mode={"ffmpeg_linear" if cfg.linear_mode else "ffmpeg_dynamic" if cfg.has_measured else "source_port"} gain_precision=f32 gain_peak_cap=0 hist_boundary_lut=1 gain_db_min={amp_to_db(gain_metrics.gain_min_amp):.2f} gain_db_max={amp_to_db(gain_metrics.gain_max_amp):.2f}', file=sys.stderr)
    stats_wall_time = stats_result.stats_q_wall_time + stats_result.host_prefix_wall_time + stats_result.stats_sums_wall_time
    print(f'stats_wall_sec={stats_wall_time:.3f} gain_wall_sec={gain_metrics.gain_wall_time:.3f} apply_wall_sec={apply_result.apply_wall_time:.3f} elapsed_sec={elapsed:.3f} realtime_x={cfg.seconds/elapsed:.1f}', file=sys.stderr)
    emit_profile_stage('stats_q', [('wall_sec', f'{stats_result.stats_q_wall_time:.6f}'), ('h2d_sec', f'{stats_result.stats_q_h2d_time:.6f}'), ('kernel_sec', f'{stats_result.stats_q_kernel_time:.6f}')])
    emit_profile_stage('host_prefix_state', [('wall_sec', f'{stats_result.host_prefix_wall_time:.6f}'), ('d2h_sec', f'{stats_result.host_prefix_d2h_time:.6f}'), ('cpu_sec', f'{stats_result.host_prefix_cpu_time:.6f}'), ('h2d_sec', f'{stats_result.host_prefix_h2d_time:.6f}')])
    emit_profile_stage('stats_sums', stats_sums_fields(args, cfg, stats_result))
    if cfg.source_exact_precompute:
        emit_profile_stage('source_precompute', source_precompute_fields(stats_result))
    emit_profile_stage('gain_plan', [('wall_sec', f'{gain_metrics.gain_wall_time:.6f}'), ('kernel_sec', f'{gain_metrics.gain_kernel_time:.6f}')])
    emit_profile_stage('device_metrics', [('wall_sec', f'{gain_metrics.metrics_wall_time:.6f}'), ('kernel_sec', f'{gain_metrics.metrics_kernel_time:.6f}'), ('d2h_sec', f'{gain_metrics.metrics_d2h_time:.6f}'), ('path', gain_metrics.metrics_path), ('copied_full_sums', gain_metrics.copied_full_sums), ('copied_full_gains', gain_metrics.copied_full_gains)])
    emit_profile_stage('apply_setup', [('wall_sec', f'{apply_result.apply_setup_wall_time:.6f}'), ('path', apply_result.apply_path), ('pinned', apply_result.apply_pinned), ('streams', apply_result.apply_stream_count), ('fallback', apply_result.apply_async_fallback)])
    emit_profile_stage('apply', apply_profile_fields(args, cfg, apply_result, bindings))
    if apply_result.exact_counts_host is not None:
        emit_profile_stage('exact_apply_counts', exact_apply_count_fields(apply_result.exact_counts_host))
    total_h2d_time = stats_result.total_h2d_time + apply_result.total_h2d_time
    total_d2h_time = stats_result.total_d2h_time + gain_metrics.total_d2h_time + apply_result.total_d2h_time
    print(f'profile_transfer h2d_sec={total_h2d_time:.6f} d2h_sec={total_d2h_time:.6f}', file=sys.stderr)
