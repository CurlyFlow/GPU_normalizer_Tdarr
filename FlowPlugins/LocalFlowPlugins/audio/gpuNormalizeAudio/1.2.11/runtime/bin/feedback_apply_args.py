import ctypes
from types import SimpleNamespace

from first_pass_output_metrics import inline_first_pass_output_sums, parallel_inline_output_metric
import kernel_args
from runtime_env import env_flag


SOURCE_FEEDBACK_MODE_NONE = 0
SOURCE_FEEDBACK_MODE_PRECOMPUTED = 2

SAFE_FEEDBACK_CUDA_FLAG_FRAME_SPECIALIZED = 1 << 4
SAFE_FEEDBACK_CUDA_FLAG_ROLLING_RING_6CH = 1 << 5
SAFE_FEEDBACK_CUDA_FLAG_SKIP_LOOKAHEAD_SCAN_6CH = 1 << 6
SAFE_FEEDBACK_CUDA_FLAG_SINGLE_WRAP_6CH = 1 << 7
SAFE_FEEDBACK_CUDA_FLAG_PARALLEL_OUTPUT_METRIC = 1 << 10


def output_sums_arg_value(ctx, apply_chunk):
    if inline_first_pass_output_sums(ctx):
        return ctx.bindings.channel_sums_arg.value
    return 0


def output_sums_arg(ctx, apply_chunk=None):
    return ctypes.c_uint64(output_sums_arg_value(ctx, apply_chunk))


def output_metric_state_args(ctx):
    if not inline_first_pass_output_sums(ctx):
        return ctypes.c_uint64(0), ctypes.c_uint64(0)
    return ctx.bindings.exact_sums_state_i_arg, ctx.bindings.exact_sums_state_d_arg


def safe_skip_output_sums_active(ctx):
    return inline_first_pass_output_sums(ctx)


def source_safe_feedback_args(ctx, *, frame_specialized=False, skip_lookahead_scan_6ch=False):
    source_precompute = bool(ctx.cfg.source.source_exact_precompute)
    source_sums_arg = ctx.bindings.source_exact_sums_arg if source_precompute else ctypes.c_uint64(0)
    source_flag_value = SOURCE_FEEDBACK_MODE_PRECOMPUTED if source_precompute else SOURCE_FEEDBACK_MODE_NONE
    if source_precompute and ctx.cfg.exact.source_skip_limiter_lookahead_scan:
        source_flag_value += 1
    if source_precompute and ctx.cfg.exact.source_fused_direct_feedback:
        source_flag_value += 2
    if frame_specialized:
        source_flag_value |= SAFE_FEEDBACK_CUDA_FLAG_FRAME_SPECIALIZED
    if getattr(ctx.cfg.exact, 'exact_skip_apply_rolling_ring_6ch', False) and ctx.args.channels == 6:
        source_flag_value |= SAFE_FEEDBACK_CUDA_FLAG_ROLLING_RING_6CH
    if skip_lookahead_scan_6ch and ctx.args.channels == 6 and env_flag('LOUDNORM_GPU_SAFE_SKIP_6CH_SKIP_LOOKAHEAD_SCAN', True):
        source_flag_value |= SAFE_FEEDBACK_CUDA_FLAG_SKIP_LOOKAHEAD_SCAN_6CH
    if (
        getattr(ctx.cfg.exact, 'exact_safe_skip_6ch_single_wrap', False)
        and ctx.args.channels == 6
        and ctx.cfg.limiter.limiter_lookahead_frames > (ctx.cfg.input_shape.frames_per_window + ctx.bindings.attack_length_arg.value)
    ):
        source_flag_value |= SAFE_FEEDBACK_CUDA_FLAG_SINGLE_WRAP_6CH
    if parallel_inline_output_metric(ctx):
        source_flag_value |= SAFE_FEEDBACK_CUDA_FLAG_PARALLEL_OUTPUT_METRIC
    return source_sums_arg, ctypes.c_uint32(source_flag_value)


def reused_safe_feedback_apply6_args(ctx, apply_chunk, *, frame_specialized=False, skip_lookahead_scan_6ch=False):
    if frame_specialized or skip_lookahead_scan_6ch or not ctx.cfg.exact.exact_apply_arg_reuse:
        return None
    cache = getattr(ctx, '_safe_feedback_apply6_arg_cache', None)
    if cache is None:
        source_sums_arg, source_flag_arg = source_safe_feedback_args(ctx)
        output_sums = output_sums_arg(ctx, apply_chunk)
        output_metric_state_i_arg, output_metric_state_d_arg = output_metric_state_args(ctx)
        cache = SimpleNamespace(
            input_base_arg=ctypes.c_uint32(0),
            input_frames_arg=ctypes.c_uint32(0),
            frames_arg=ctypes.c_uint32(0),
            source_sums_arg=source_sums_arg,
            output_sums_arg=output_sums,
            output_metric_state_i_arg=output_metric_state_i_arg,
            output_metric_state_d_arg=output_metric_state_d_arg,
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
            cache.output_metric_state_i_arg,
            cache.output_metric_state_d_arg,
            cache.source_flag_arg,
        )
        ctx._safe_feedback_apply6_arg_cache = cache
    cache.input_base_arg.value = apply_chunk.input_base_arg.value
    cache.input_frames_arg.value = apply_chunk.input_frames_arg.value
    cache.frames_arg.value = apply_chunk.this_frames
    cache.output_sums_arg.value = output_sums_arg_value(ctx, apply_chunk)
    return cache.args


def safe_feedback_apply6_args(ctx, apply_chunk, *, frame_specialized=False, skip_lookahead_scan_6ch=False):
    reused_args = reused_safe_feedback_apply6_args(ctx, apply_chunk, frame_specialized=frame_specialized, skip_lookahead_scan_6ch=skip_lookahead_scan_6ch)
    if reused_args is not None:
        return reused_args

    bindings = ctx.bindings
    frames_arg = ctypes.c_uint32(apply_chunk.this_frames)
    source_sums_arg, source_flag_arg = source_safe_feedback_args(ctx, frame_specialized=frame_specialized, skip_lookahead_scan_6ch=skip_lookahead_scan_6ch)
    output_sums = output_sums_arg(ctx, apply_chunk)
    output_metric_state_i_arg, output_metric_state_d_arg = output_metric_state_args(ctx)
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
        output_sums,
        output_metric_state_i_arg,
        output_metric_state_d_arg,
        source_flag_arg,
    )
    args._refs = (frames_arg, source_sums_arg, output_sums, output_metric_state_i_arg, output_metric_state_d_arg, source_flag_arg)
    return args
