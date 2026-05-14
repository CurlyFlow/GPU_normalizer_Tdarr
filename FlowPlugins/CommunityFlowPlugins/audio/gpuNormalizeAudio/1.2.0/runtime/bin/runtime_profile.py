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


def emit_runtime_summary(args, cfg, *, gpu_name, elapsed, stats_result, gain_metrics, apply_result, bindings):
    segmented_safe_feedback_profile = apply_result.segmented_safe_feedback_profile
    print(f'gpu={gpu_name}', file=sys.stderr)
    source_mode = 'stereo_fallback_source_precompute' if cfg.source_exact_precompute else 'stereo_fallback_source_exact' if cfg.source_faithful_stereo else 'default'
    print(f'audio_seconds={cfg.seconds:.3f} rate={args.rate} channels={args.channels} windows={cfg.windows} pcm_mib={cfg.mib:.1f} chunk_mib={cfg.chunk_bytes/(1024*1024):.1f} stats_chunk_mib={cfg.stats_chunk_bytes/(1024*1024):.1f} input_format={args.input_format} output_format={args.output_format} streaming_io={1 if cfg.streaming_io else 0} source_mode={source_mode} source_precompute_windows={cfg.source_precompute_windows} source_precompute_from_channel_sums={1 if cfg.source_precompute_from_channel_sums else 0} source_channel_hist4_exact={1 if cfg.source_channel_hist4_exact else 0} source_channel_hist4_boundary={1 if cfg.source_channel_hist4_boundary else 0} source_channel_hist4_margin_lu={cfg.source_channel_hist4_margin_lu:.6g} source_precompute_in_stats={1 if cfg.source_precompute_in_stats else 0} source_block_sums={1 if cfg.source_block_sums else 0} source_block_frames={cfg.source_block_frames} source_sum_audit={1 if cfg.source_sum_audit else 0}', file=sys.stderr)
    print(f'target_i={args.target_i:.2f} target_lra={args.target_lra:.2f} target_tp={args.target_tp:.2f} effective_tp={cfg.effective_tp:.2f} max_gain_db={args.max_gain_db:.2f}', file=sys.stderr)
    if cfg.has_measured:
        print(f'cpu_loudnorm_first_pass measured_i={args.measured_i:.2f} measured_lra={args.measured_lra:.2f} measured_tp={args.measured_tp:.2f} measured_thresh={args.measured_thresh:.2f} offset_db={cfg.runtime_offset_db:.2f} linear_mode={1 if cfg.linear_mode else 0}', file=sys.stderr)
    print(f'planner=cuda_source_port_ebur128_delta gain_mode={"ffmpeg_linear" if cfg.linear_mode else "ffmpeg_dynamic" if cfg.has_measured else "source_port"} gain_precision=f32 gain_peak_cap=0 hist_boundary_lut=1 gain_db_min={amp_to_db(gain_metrics.gain_min_amp):.2f} gain_db_max={amp_to_db(gain_metrics.gain_max_amp):.2f}', file=sys.stderr)
    stats_wall_time = stats_result.stats_q_wall_time + stats_result.host_prefix_wall_time + stats_result.stats_sums_wall_time
    print(f'stats_wall_sec={stats_wall_time:.3f} gain_wall_sec={gain_metrics.gain_wall_time:.3f} apply_wall_sec={apply_result.apply_wall_time:.3f} elapsed_sec={elapsed:.3f} realtime_x={cfg.seconds/elapsed:.1f}', file=sys.stderr)
    print(format_profile_stage('stats_q', [('wall_sec', f'{stats_result.stats_q_wall_time:.6f}'), ('h2d_sec', f'{stats_result.stats_q_h2d_time:.6f}'), ('kernel_sec', f'{stats_result.stats_q_kernel_time:.6f}')]), file=sys.stderr)
    print(format_profile_stage('host_prefix_state', [('wall_sec', f'{stats_result.host_prefix_wall_time:.6f}'), ('d2h_sec', f'{stats_result.host_prefix_d2h_time:.6f}'), ('cpu_sec', f'{stats_result.host_prefix_cpu_time:.6f}'), ('h2d_sec', f'{stats_result.host_prefix_h2d_time:.6f}')]), file=sys.stderr)
    stats_exact_mode = 'stream_f64' if cfg.exact_stats_stream else 'prefix_channel_f64' if cfg.exact_prefix_channel_stats else 'channel_stream_f64' if cfg.exact_limiter_active and args.input_format == 'f64le' else 'parallel_f64' if args.input_format == 'f64le' else 'parallel_f32'
    print(format_profile_stage('stats_sums', [('wall_sec', f'{stats_result.stats_sums_wall_time:.6f}'), ('h2d_sec', f'{stats_result.stats_sums_h2d_time:.6f}'), ('kernel_sec', f'{stats_result.stats_sums_kernel_time:.6f}'), ('exact_mode', stats_exact_mode)]), file=sys.stderr)
    print(format_profile_stage('gain_plan', [('wall_sec', f'{gain_metrics.gain_wall_time:.6f}'), ('kernel_sec', f'{gain_metrics.gain_kernel_time:.6f}')]), file=sys.stderr)
    print(format_profile_stage('device_metrics', [('wall_sec', f'{gain_metrics.metrics_wall_time:.6f}'), ('kernel_sec', f'{gain_metrics.metrics_kernel_time:.6f}'), ('d2h_sec', f'{gain_metrics.metrics_d2h_time:.6f}'), ('path', gain_metrics.metrics_path), ('copied_full_sums', gain_metrics.copied_full_sums), ('copied_full_gains', gain_metrics.copied_full_gains)]), file=sys.stderr)
    print(format_profile_stage('apply_setup', [('wall_sec', f'{apply_result.apply_setup_wall_time:.6f}'), ('path', apply_result.apply_path), ('pinned', apply_result.apply_pinned), ('streams', apply_result.apply_stream_count), ('fallback', apply_result.apply_async_fallback)]), file=sys.stderr)
    print(format_profile_stage('apply', [
        ('wall_sec', f'{apply_result.apply_wall_time:.6f}'),
        ('h2d_sec', f'{apply_result.apply_h2d_time:.6f}'),
        ('kernel_sec', f'{apply_result.apply_kernel_time:.6f}'),
        ('d2h_sec', f'{apply_result.apply_d2h_time:.6f}'),
        ('path', apply_result.apply_path),
        ('pinned', apply_result.apply_pinned),
        ('streams', apply_result.apply_stream_count),
        ('fallback', apply_result.apply_async_fallback),
        ('input_format', args.input_format),
        ('output_format', args.output_format),
        ('ffmpeg_timing', 1 if cfg.apply_ffmpeg_timing else 0),
        ('ffmpeg_limiter', 1 if cfg.exact_limiter_requested else 0),
        ('ffmpeg_final_flush', 1 if cfg.exact_limiter_requested else 0),
        ('parallel_final_apply', 1 if cfg.parallel_final_apply else 0),
        ('exact_prefill_output', 1 if cfg.exact_prefill_output else 0),
        ('exact_use_prefilled_output', 1 if cfg.exact_use_prefilled_output else 0),
        ('exact_sparse_chunks', 1 if cfg.exact_sparse_chunks else 0),
        ('exact_skip_safe_fill', 1 if cfg.exact_skip_safe_fill else 0),
        ('exact_skip_safe_feedback', 1 if cfg.exact_skip_safe_feedback else 0),
        ('exact_force_safe_idle', 1 if cfg.exact_force_safe_idle else 0),
        ('exact_segmented_safe_feedback', 1 if cfg.exact_segmented_safe_feedback else 0),
        ('exact_safe_feedback_prefix', 1 if cfg.exact_safe_feedback_prefix else 0),
        ('exact_safe_feedback_window_accum', 1 if cfg.exact_safe_feedback_window_accum else 0),
        ('exact_safe_feedback_slot_accum', 1 if cfg.exact_safe_feedback_slot_accum else 0),
        ('exact_parallel_unsafe_feedback', 1 if cfg.exact_parallel_unsafe_feedback else 0),
        ('exact_skip_unsafe_feedback', 1 if cfg.exact_skip_unsafe_feedback else 0),
        ('exact_parallel_skip_safe_feedback', 1 if cfg.exact_parallel_skip_safe_feedback else 0),
        ('source_parallel_skip_before_threshold', 1 if cfg.source_parallel_skip_before_threshold else 0),
        ('source_unsafe_skip_kernel', 1 if cfg.source_unsafe_skip_kernel else 0),
        ('exact_use_risk_map', 1 if cfg.exact_use_risk_map else 0),
        ('source_faithful_stereo', 1 if cfg.source_faithful_stereo else 0),
        ('source_exact_precompute', 1 if cfg.source_exact_precompute else 0),
        ('source_precompute_in_stats', 1 if cfg.source_precompute_in_stats else 0),
        ('exact_channel_stats_combined_peaks', 1 if cfg.exact_channel_stats_combined_peaks else 0),
        ('exact_stats_parallel_peaks', 1 if cfg.exact_stats_parallel_peaks else 0),
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
        ('segmented_safe_feedback_chunks', segmented_safe_feedback_profile.chunks),
        ('parallel_unsafe_feedback_chunks', segmented_safe_feedback_profile.unsafe_chunks),
        ('parallel_skip_safe_feedback_chunks', segmented_safe_feedback_profile.parallel_skip_chunks),
        ('segmented_safe_feedback_windows', segmented_safe_feedback_profile.windows),
        ('segmented_safe_feedback_fallback_chunks', segmented_safe_feedback_profile.fallback_chunks),
        ('segmented_safe_feedback_apply_sec', f'{segmented_safe_feedback_profile.apply_time:.6f}'),
        ('parallel_unsafe_feedback_apply_sec', f'{segmented_safe_feedback_profile.unsafe_apply_time:.6f}'),
        ('parallel_skip_safe_feedback_apply_sec', f'{segmented_safe_feedback_profile.parallel_skip_time:.6f}'),
        ('segmented_safe_feedback_energy_sec', f'{segmented_safe_feedback_profile.energy_time:.6f}'),
        ('segmented_safe_feedback_window_sec', f'{segmented_safe_feedback_profile.window_time:.6f}'),
        ('segmented_safe_feedback_stitch_sec', f'{segmented_safe_feedback_profile.stitch_time:.6f}'),
        ('ffmpeg_gain_offset_ms', f'{args.ffmpeg_gain_offset_ms:.3f}'),
        ('ffmpeg_gain_offset_frames', bindings.gain_timing_offset_arg.value),
    ]), file=sys.stderr)
    if apply_result.exact_counts_host is not None:
        exact_counts_host = apply_result.exact_counts_host
        print(format_profile_stage('exact_apply_counts', [
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
        ]), file=sys.stderr)
    total_h2d_time = stats_result.total_h2d_time + apply_result.total_h2d_time
    total_d2h_time = stats_result.total_d2h_time + gain_metrics.total_d2h_time + apply_result.total_d2h_time
    print(f'profile_transfer h2d_sec={total_h2d_time:.6f} d2h_sec={total_d2h_time:.6f}', file=sys.stderr)
