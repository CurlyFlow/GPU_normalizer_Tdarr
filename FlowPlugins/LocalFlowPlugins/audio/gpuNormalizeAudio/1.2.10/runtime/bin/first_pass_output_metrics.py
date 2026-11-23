from runtime_env import env_flag


def _output_metric_flags(ctx):
    flags = getattr(ctx.cfg, '_first_pass_output_metric_flags', None)
    if flags is not None:
        return flags

    emit = bool(ctx.cfg.exact.emit_first_pass_json)
    inline = bool(emit and env_flag('LOUDNORM_GPU_FIRST_PASS_OUTPUT_INLINE_SUMS'))
    flags = {
        'inline': inline,
        'native': bool(emit and env_flag('LOUDNORM_GPU_FIRST_PASS_OUTPUT_NATIVE', True)),
        'inline_native_audit': bool(inline and env_flag('LOUDNORM_GPU_FIRST_PASS_OUTPUT_INLINE_AUDIT_NATIVE')),
        'parallel_inline_metric': bool(inline and env_flag('LOUDNORM_GPU_FIRST_PASS_OUTPUT_INLINE_PARALLEL_METRIC')),
    }
    ctx.cfg._first_pass_output_metric_flags = flags
    return flags


def inline_first_pass_output_sums(ctx):
    return _output_metric_flags(ctx)['inline']


def native_first_pass_output_sums(ctx):
    return _output_metric_flags(ctx)['native']


def inline_output_sums_native_audit(ctx):
    return _output_metric_flags(ctx)['inline_native_audit']


def parallel_inline_output_metric(ctx):
    return _output_metric_flags(ctx)['parallel_inline_metric']
