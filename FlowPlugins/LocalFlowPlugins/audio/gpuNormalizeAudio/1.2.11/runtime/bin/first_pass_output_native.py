from cuda_driver import chk
from first_pass_output_metrics import inline_first_pass_output_sums, inline_output_sums_native_audit, native_first_pass_output_sums
from stats_channel_native import init_native_output_sums, run_native_output_sums_chunk


def capture_first_pass_output_metrics_native(ctx, result, payload_ptr, frames, frame_offset):
    audit_native = inline_output_sums_native_audit(ctx)
    if inline_first_pass_output_sums(ctx) and not audit_native:
        return
    if not native_first_pass_output_sums(ctx):
        return
    state_attr = 'native_first_pass_output_sums_audit' if audit_native else 'native_first_pass_output_sums'
    native_state = getattr(ctx, state_attr, None)
    if native_state is None:
        native_state = init_native_output_sums(ctx)
        setattr(ctx, state_attr, native_state)
    dt = run_native_output_sums_chunk(ctx, native_state, payload_ptr, frames, frame_offset, copy_to_device=not audit_native)
    result.first_pass_output_metric_kernel_time += dt


def reset_first_pass_output_metrics(ctx):
    if not ctx.cfg.exact.emit_first_pass_json:
        return
    chk(ctx.cuda.cuMemsetD32_v2(ctx.buffers.d_channel_sums, 0, ctx.cfg.input_shape.windows * 2), 'cuMemsetD32(first-pass output sums)')
    chk(ctx.cuda.cuMemsetD32_v2(ctx.buffers.d_exact_sums_state_i, 0, 8), 'cuMemsetD32(first-pass output state_i)')
    chk(ctx.cuda.cuMemsetD32_v2(ctx.buffers.d_exact_sums_state_d, 0, (ctx.args.channels * 4 + 1) * 2), 'cuMemsetD32(first-pass output state_d)')
    if native_first_pass_output_sums(ctx) and not inline_first_pass_output_sums(ctx):
        ctx.native_first_pass_output_sums = init_native_output_sums(ctx)
    if inline_output_sums_native_audit(ctx):
        ctx.native_first_pass_output_sums_audit = init_native_output_sums(ctx)
