import ctypes

from cuda_launch import launch_timed_kernel
from first_pass_output_metrics import inline_first_pass_output_sums, native_first_pass_output_sums
import kernel_args
from runtime_env import env_flag as _env_flag


def capture_first_pass_output_metrics(ctx, result, apply_chunk):
    if not ctx.cfg.exact.emit_first_pass_json:
        return
    if inline_first_pass_output_sums(ctx):
        return
    if native_first_pass_output_sums(ctx):
        return
    cfg = ctx.cfg
    if (
        _env_flag('LOUDNORM_GPU_FIRST_PASS_OUTPUT_WINDOW_PARALLEL')
        and not cfg.source.source_faithful_stereo
        and apply_chunk.frame_offset % cfg.input_shape.frames_per_window == 0
        and (
            apply_chunk.this_frames % cfg.input_shape.frames_per_window == 0
            or apply_chunk.frame_offset + apply_chunk.this_frames >= cfg.input_shape.total_frames
        )
        and getattr(ctx.kernels.output_prefix_start_states_fn, 'value', 0)
    ):
        frames_arg = ctypes.c_uint32(apply_chunk.this_frames)
        first_window = apply_chunk.frame_offset // cfg.input_shape.frames_per_window
        windows_this = (apply_chunk.this_frames + cfg.input_shape.frames_per_window - 1) // cfg.input_shape.frames_per_window
        first_window_arg = ctypes.c_uint32(first_window)
        windows_this_arg = ctypes.c_uint32(windows_this)
        q_args = kernel_args.build_q_args(
            ctx.bindings.out_arg,
            ctx.bindings.q_states_arg,
            ctx.bindings.peaks_arg,
            frames_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            first_window_arg,
            ctx.bindings.a_arg,
        )
        q_fn = ctx.kernels.q_fn
        q_label = 'first-pass-output-q-states'
        prefix_fn = ctx.kernels.output_prefix_start_states_fn
        prefix_label = 'first-pass-output-prefix-start-states'
        prefix_grid_x = ctx.args.channels
        prefix_block_x = 1
        if (
            _env_flag('LOUDNORM_GPU_FIRST_PASS_OUTPUT_WINDOW_FAST_Q_PREFIX')
            or _env_flag('LOUDNORM_GPU_FIRST_PASS_OUTPUT_WINDOW_Q_NO_PEAKS')
        ):
            if getattr(ctx.kernels.q_no_peaks_fn, 'value', 0):
                q_fn = ctx.kernels.q_no_peaks_fn
                q_label = 'first-pass-output-q-states-no-peaks'
        if (
            _env_flag('LOUDNORM_GPU_FIRST_PASS_OUTPUT_WINDOW_FAST_Q_PREFIX')
            or _env_flag('LOUDNORM_GPU_FIRST_PASS_OUTPUT_WINDOW_PREFIX_SHARED')
        ):
            if getattr(ctx.kernels.output_prefix_start_states_shared_fn, 'value', 0):
                prefix_fn = ctx.kernels.output_prefix_start_states_shared_fn
                prefix_label = 'first-pass-output-prefix-start-states-shared'
                prefix_grid_x = 1
                prefix_block_x = 32
        prefix_args = kernel_args.build_prefix_start_state_range_args(
            ctx.bindings.q_states_arg,
            ctx.bindings.start_states_arg,
            ctx.bindings.exact_sums_state_i_arg,
            ctx.bindings.exact_sums_state_d_arg,
            first_window_arg,
            windows_this_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctx.bindings.total_frames_arg,
            ctx.bindings.a_arg,
        )
        use_checkpoint_start = bool(
            _env_flag('LOUDNORM_GPU_FIRST_PASS_OUTPUT_WINDOW_CHECKPOINT_START')
            and getattr(ctx.kernels.channel_checkpoint_states_fn, 'value', 0)
        )
        null_arg = ctypes.c_uint64(0)
        checkpoint_args = kernel_args.build_channel_checkpoint_args(
            ctx.bindings.out_arg,
            null_arg,
            ctx.bindings.exact_sums_state_d_arg,
            ctx.bindings.start_states_arg,
            null_arg,
            frames_arg,
            ctx.bindings.channels_arg,
            ctx.bindings.frame_window_arg,
            ctypes.c_uint32(apply_chunk.frame_offset),
            ctx.bindings.a_arg,
        ) if use_checkpoint_start else None
        use_channel_metric = bool(
            _env_flag('LOUDNORM_GPU_FIRST_PASS_OUTPUT_WINDOW_CHANNEL_METRIC')
            and getattr(ctx.kernels.prefix_channel_sums_fn, 'value', 0)
        )
        if use_channel_metric:
            local_window_offset_arg = ctypes.c_uint32(0)
            local_start_states_arg = ctypes.c_uint64(ctx.buffers.d_start_states.value + (first_window * ctx.args.channels * 4 * 8))
            output_sums_arg = ctypes.c_uint64(ctx.buffers.d_channel_sums.value + (first_window * 8))
            channel_sums_fn = ctx.kernels.prefix_channel_sums_fn
            channel_sums_label = 'first-pass-output-channel-window-sums'
            if (
                _env_flag('LOUDNORM_GPU_FIRST_PASS_OUTPUT_WINDOW_CHANNEL_UNROLL4')
                and getattr(ctx.kernels.prefix_channel_sums_unroll4_fn, 'value', 0)
            ):
                channel_sums_fn = ctx.kernels.prefix_channel_sums_unroll4_fn
                channel_sums_label = 'first-pass-output-channel-window-sums-unroll4'
            sums_args = kernel_args.build_sums_args(
                ctx.bindings.out_arg,
                ctx.bindings.q_states_arg,
                local_start_states_arg,
                frames_arg,
                ctx.bindings.channels_arg,
                ctx.bindings.frame_window_arg,
                local_window_offset_arg,
                ctx.bindings.b_arg,
                ctx.bindings.a_arg,
            )
            combine_args = kernel_args.build_combine_sums_args(
                ctx.bindings.q_states_arg,
                output_sums_arg,
                windows_this_arg,
                ctx.bindings.channels_arg,
            )
        else:
            sums_args = kernel_args.build_sums_args(
                ctx.bindings.out_arg,
                ctx.bindings.channel_sums_arg,
                ctx.bindings.start_states_arg,
                frames_arg,
                ctx.bindings.channels_arg,
                ctx.bindings.frame_window_arg,
                first_window_arg,
                ctx.bindings.b_arg,
                ctx.bindings.a_arg,
            )
            combine_args = None
        grid_pairs = min(65535, max(1, (windows_this * ctx.args.channels + 255) // 256))
        grid_windows = min(65535, max(1, (windows_this + 255) // 256))
        if use_checkpoint_start:
            q_dt = 0.0
            prefix_dt = launch_timed_kernel(ctx.cuda, 'first-pass-output-checkpoint-start-states', ctx.kernels.channel_checkpoint_states_fn, checkpoint_args, grid_x=ctx.args.channels, block_x=1)
        else:
            q_dt = launch_timed_kernel(ctx.cuda, q_label, q_fn, q_args, grid_x=grid_pairs, block_x=256)
            prefix_dt = launch_timed_kernel(ctx.cuda, prefix_label, prefix_fn, prefix_args, grid_x=prefix_grid_x, block_x=prefix_block_x)
        if use_channel_metric:
            sums_dt = launch_timed_kernel(ctx.cuda, channel_sums_label, channel_sums_fn, sums_args, grid_x=grid_pairs, block_x=256)
            combine_dt = launch_timed_kernel(ctx.cuda, 'first-pass-output-combine-channel-sums', ctx.kernels.combine_sums_fn, combine_args, grid_x=grid_windows, block_x=256)
        else:
            sums_dt = launch_timed_kernel(ctx.cuda, 'first-pass-output-window-sums', ctx.kernels.sums_fn, sums_args, grid_x=grid_windows, block_x=256)
            combine_dt = 0.0
        dt = q_dt + prefix_dt + sums_dt + combine_dt
        result.apply_kernel_time += dt
        result.first_pass_output_metric_kernel_time += dt
        return
    frames_arg = ctypes.c_uint32(apply_chunk.this_frames)
    exact_args = kernel_args.build_exact_sums_args(
        ctx.bindings.out_arg,
        ctx.bindings.channel_sums_arg,
        ctx.bindings.exact_sums_state_i_arg,
        ctx.bindings.exact_sums_state_d_arg,
        frames_arg,
        ctx.bindings.channels_arg,
        ctx.bindings.frame_window_arg,
        ctx.bindings.b_arg,
        ctx.bindings.a_arg,
    )
    dt = launch_timed_kernel(ctx.cuda, 'first-pass-output-sums', ctx.kernels.exact_sums_fn, exact_args)
    result.apply_kernel_time += dt
    result.first_pass_output_metric_kernel_time += dt
