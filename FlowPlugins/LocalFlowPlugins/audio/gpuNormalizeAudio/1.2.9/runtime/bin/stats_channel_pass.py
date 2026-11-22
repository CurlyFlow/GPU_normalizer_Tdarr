import ctypes
import time

from cuda_driver import chk
from cuda_launch import launch_timed_kernel
import kernel_args
from stats_channel_execution import ChannelStatsExecution
from stats_channel_mode import create_channel_stats_mode
from stats_channel_native import native_channel_stats_supported, run_native_channel_stats_pass
from stats_source_stage import _apply_streaming_size_update
from stream_ingress_resample import frame_chunk_reader_for


def run_exact_sums_pass(ctx, result):
    args = ctx.args
    cfg = ctx.cfg
    host_in = ctx.host_io.host_in
    host_in_ptr = ctx.host_io.host_in_ptr

    with frame_chunk_reader_for(
        ctx,
        cfg.input_shape.decode_command,
        'streaming decode pass 1',
        host_in,
        chunk_bytes=cfg.sizing.stats_chunk_bytes,
        partial_frame_error='streaming exact sums ended with a partial frame',
        staging_label='streaming exact sums staging',
        short_read_error='short input read during exact sums',
    ) as chunks:
        for chunk in chunks:
            frames_arg = ctypes.c_uint32(chunk.this_frames)
            exact_sums_args = kernel_args.build_exact_sums_args(
                ctx.bindings.in_arg,
                ctx.bindings.sums_arg,
                ctx.bindings.exact_sums_state_i_arg,
                ctx.bindings.exact_sums_state_d_arg,
                frames_arg,
                ctx.bindings.channels_arg,
                ctx.bindings.frame_window_arg,
                ctx.bindings.b_arg,
                ctx.bindings.a_arg,
            )
            stage_t0 = time.perf_counter()
            t0 = time.perf_counter()
            chk(ctx.cuda.cuMemcpyHtoD_v2(ctx.buffers.d_in, ctypes.c_void_p(host_in_ptr), chunk.this_bytes), 'cuMemcpyHtoD(exact sums input)')
            copy_dt = time.perf_counter() - t0
            kernel_dt = launch_timed_kernel(ctx.cuda, 'exact-sums', ctx.kernels.exact_sums_fn, exact_sums_args)
            result.stats_sums_h2d_time += copy_dt
            result.total_h2d_time += copy_dt
            result.stats_sums_kernel_time += kernel_dt
            result.stats_sums_wall_time += time.perf_counter() - stage_t0
            ctx.emit_progress('stats_sums', 0.70 * (chunks.done_bytes / float(cfg.input_shape.nbytes)))
        if cfg.root.streaming_io:
            _apply_streaming_size_update(ctx, result, chunks.done_bytes)
            ctx.emit_progress('stats_sums', 0.70)


def run_channel_stats_pass(ctx, result):
    args = ctx.args
    cfg = ctx.cfg
    host_in = ctx.host_io.host_in
    mode = create_channel_stats_mode(ctx)
    if cfg.input_shape.ingress_rate == args.rate and native_channel_stats_supported(ctx, mode.source_stage_config):
        run_native_channel_stats_pass(ctx, result, mode.source_stage_config)
        return

    with ChannelStatsExecution(ctx, result, mode) as execution:
        reader_options = execution.frame_reader_options()
        with frame_chunk_reader_for(
            ctx,
            cfg.input_shape.decode_command,
            'streaming decode stats channel',
            host_in,
            chunk_bytes=cfg.sizing.stats_chunk_bytes,
            partial_frame_error='streaming channel stats ended with a partial frame',
            staging_label='streaming channel stats staging',
            short_read_error='short input read during channel stats',
            direct_payload=reader_options['direct_payload'],
            direct_bytearray_payload=reader_options['direct_bytearray_payload'],
            direct_payload_buffers=reader_options['direct_payload_buffers'],
            auto_return_payload=reader_options['auto_return_payload'],
        ) as chunks:
            chunk_index = 0
            for chunk in chunks:
                execution.process_chunk(chunk, chunk_index, chunks.done_bytes)
                chunk_index += 1
            execution.finish(chunks.done_bytes)
