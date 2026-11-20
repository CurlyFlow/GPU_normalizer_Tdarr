import ast
import re
import sys
from pathlib import Path

from cuda_kernel_manifest import CUDA_KERNEL_SYMBOLS, KERNEL_HANDLE_ATTRS


DEFAULT_CUDA_SOURCE = Path(__file__).resolve().parents[1] / 'cuda' / 'loudnorm_source_port_kernels.cu'

# CUDA and Python use different local names for a few equivalent ABI slots. This
# normalization compares semantic argument order without duplicating signatures.
PARAM_NAME_ALIASES = {
    'in': 'input',
    'out': 'output',
    'n': 'samples',
    'n_prefill': 'samples',
    'peaks': 'peak_bits',
    'primary_peaks': 'primary_peak_bits',
    'partner_peaks': 'partner_peak_bits',
    'frame_window': 'frames_per_window',
    'frame_offset': 'global_frame_offset',
    'offset': 'global_frame_offset',
    'window_offset': 'global_window_offset',
    'combine_windows': 'windows',
    'exact_sums_state_i': 'state_i',
    'feedback_state_i': 'state_i',
    'exact_sums_state_d': 'state_d',
    'feedback_state_d': 'state_d',
    'feedback_hist': 'hist',
    'limiter_prev': 'prev_smp',
    'safe_feedback_frames': 'frame_energy',
    'input_base': 'input_base_frame',
    'limiter_lookahead': 'limiter_lookahead_frames',
    'gain_timing_offset': 'gain_timing_offset_frames',
    'output_offset': 'output_frame_offset',
    'output_frame': 'output_frame_offset',
    'write_frame': 'write_frame_start',
    'ffmpeg_state_audit_i': 'audit_i',
    'ffmpeg_state_audit_d': 'audit_d',
    'ffmpeg_state_audit_max_events': 'audit_max_events',
    'ffmpeg_state_audit_sample_windows': 'audit_sample_windows',
    'exact_target_i': 'target_i',
    'exact_target_lra': 'target_lra',
    'exact_measured_i': 'measured_i',
    'exact_measured_thresh': 'measured_thresh',
    'exact_offset_amp': 'offset_amp',
    'exact_limiter_ceiling': 'ceiling',
}

BUILDER_PARAM_ALIASES = {
    ('build_source_exact_sums_args', 'in'): 'source_energy',
    ('build_combine_sums_args', 'source_sums'): 'channel_sums',
    ('build_exact_feedback_apply_args', 'sums'): 'window_sums',
    ('build_safe_feedback_apply6_args', 'sums'): 'window_sums',
    ('build_gain_args', 'sums'): 'window_sums',
    ('build_metrics_args', 'sums'): 'window_sums',
    ('build_safe_feedback_window_args', 'feedback_window_sums'): 'window_sums',
    ('build_safe_feedback_apply6_args', 'frames'): 'output_frames',
    ('build_channel_stats_args', 'q_states'): 'states',
    ('build_channel_stats_source_energy_args', 'q_states'): 'states',
    ('build_channel_stats_offset_args', 'q_states'): 'states',
}

KERNEL_PARAM_ALIASES = {
    ('kweight_window_channel_sums_f64_prefix_kernel', 'channel_sums'): 'sums',
    ('kweight_window_channel_sums_f64_prefix_unroll4_kernel', 'channel_sums'): 'sums',
}

KERNEL_ARG_BUILDERS = {
    'short_source_filter_f64_kernel': 'build_short_filter_args',
    'short_source_gain_f64_kernel': 'build_short_gain_args',
    'short_source_apply_f64_kernel': 'build_short_apply_args',
    'apply_linear_f64_io_kernel': 'build_linear_apply_args',
    'apply_plan_f64_io_ffmpeg_feedback_limiter_stream_kernel': 'build_exact_feedback_apply_args',
    'apply_plan_f64_io_ffmpeg_timing_final_kernel': 'build_ffmpeg_timing_apply_args',
    'apply_plan_f64_io_ffmpeg_timing_final_window_kernel': 'build_prefill_args',
    'apply_plan_f64_io_ffmpeg_timing_kernel': 'build_ffmpeg_timing_apply_args',
    'apply_plan_f64_io_kernel': 'build_apply_args',
    'apply_plan_f64_kernel': 'build_apply_args',
    'apply_plan_kernel': 'build_apply_args',
    'combine_channel_sums_kernel': 'build_combine_sums_args',
    'compact_f64_channels_offset_kernel': 'build_compact_offset_args',
    'convert_f64_to_f32_kernel': 'build_convert_f64_to_f32_args',
    'kweight_build_start_states_f64_kernel': 'build_prefix_start_state_args',
    'kweight_build_start_states_range_f64_kernel': 'build_prefix_start_state_range_args',
    'kweight_build_start_states_range_shared_f64_kernel': 'build_prefix_start_state_range_args',
    'kweight_window_channel_sums_f64_prefix_kernel': 'build_sums_args',
    'kweight_window_channel_sums_f64_prefix_unroll4_kernel': 'build_sums_args',
    'kweight_window_checkpoint_states_f64_channel_kernel': 'build_channel_checkpoint_args',
    'kweight_window_q_f64_kernel': 'build_q_args',
    'kweight_window_q_f64_no_peaks_kernel': 'build_q_args',
    'kweight_window_q_kernel': 'build_q_args',
    'kweight_window_sums_f64_channel_kernel': 'build_channel_stats_args',
    'kweight_window_sums_f64_channel_no_peaks_kernel': 'build_channel_stats_args',
    'kweight_window_sums_f64_channel_offset_kernel': 'build_channel_stats_offset_args',
    'kweight_window_sums_f64_channel_source_energy_kernel': 'build_channel_stats_source_energy_args',
    'kweight_window_sums_f64_channel_unroll4_kernel': 'build_channel_stats_args',
    'kweight_window_sums_f64_channel_warp_kernel': 'build_channel_stats_args',
    'kweight_window_sums_f64_kernel': 'build_sums_args',
    'kweight_window_sums_f64_paired_combined_kernel': 'build_paired_combined_channel_stats_args',
    'kweight_window_sums_f64_stream_kernel': 'build_exact_sums_args',
    'kweight_window_sums_kernel': 'build_sums_args',
    'safe_feedback_apply6_f64_kernel': 'build_safe_feedback_apply6_args',
    'safe_feedback_channel_energy_f64_kernel': 'build_safe_feedback_energy_args',
    'safe_feedback_fill_prefilled_exact_f64_kernel': 'build_safe_feedback_fill_args',
    'safe_feedback_skip_apply6_f64_kernel': 'build_safe_feedback_apply6_args',
    'safe_feedback_stitch_f64_kernel': 'build_safe_feedback_stitch_args',
    'safe_feedback_window_sums_f64_kernel': 'build_safe_feedback_window_args',
    'source_port_gain_kernel': 'build_gain_args',
    'source_port_metrics_kernel': 'build_metrics_args',
    'source_stereo_apply_short_raw_corrections_f64_kernel': 'build_source_apply_short_raw_corrections_args',
    'source_stereo_block_exact_sums_f64_kernel': 'build_source_block_exact_sums_args',
    'source_stereo_block_prefix_sums_f64_kernel': 'build_source_block_prefix_sums_args',
    'source_stereo_block_sums_f64_kernel': 'build_source_block_sums_args',
    'source_stereo_energy_f64_kernel': 'build_source_energy_args',
    'source_stereo_energy_packed_f64_kernel': 'build_source_energy_args',
    'source_stereo_energy_packed_hoist_f64_kernel': 'build_source_energy_args',
    'source_stereo_exact_hist4_sums_f64_kernel': 'build_source_exact_hist4_sums_args',
    'source_stereo_exact_short_sums_f64_kernel': 'build_source_exact_short_sums_args',
    'source_stereo_exact_sums_f64_kernel': 'build_source_exact_sums_args',
    'source_stereo_exact_sums_from_channel_sums_f64_kernel': 'build_source_exact_from_channel_sums_args',
    'source_stereo_exact_sums_split_f64_kernel': 'build_source_exact_sums_args',
    'source_stereo_exact_sums_split_pointer_f64_kernel': 'build_source_exact_sums_args',
    'source_stereo_exact_sums_split_readonly_f64_kernel': 'build_source_exact_sums_args',
    'source_stereo_exact_sums_split_unroll4_f64_kernel': 'build_source_exact_sums_args',
    'source_stereo_mark_short_raw_corrections_f64_kernel': 'build_source_mark_short_raw_corrections_args',
    'source_stereo_selective_hist4_sums_f64_kernel': 'build_source_selective_hist4_sums_args',
    'source_stereo_selective_short_sums_f64_kernel': 'build_source_selective_short_sums_args',
    'window_peaks_f64_kernel': 'build_peak_args',
    'window_peaks_f64_offset_kernel': 'build_peak_offset_args',
}


def read_cuda_source_with_local_includes(path, seen=None):
    seen = set() if seen is None else seen
    path = Path(path).resolve()
    if path in seen:
        raise RuntimeError(f'Circular CUDA include: {path}')
    seen.add(path)
    out = []
    for line in path.read_text().splitlines(keepends=True):
        stripped = line.strip()
        if stripped.startswith('#include "') and stripped.endswith('"'):
            include_name = stripped[len('#include "'):-1]
            out.append(read_cuda_source_with_local_includes(path.parent / include_name, seen))
        else:
            out.append(line)
    seen.remove(path)
    return ''.join(out)


def _cuda_param_name(param):
    param = re.sub(r'\b(__restrict__|const)\b', ' ', param)
    param = re.sub(r'\s+', ' ', param.replace('\n', ' ')).strip()
    return param.rsplit(' ', 1)[-1].lstrip('*&')


def _split_cuda_params(params):
    params = params.strip()
    if not params or params == 'void':
        return ()
    return tuple(_cuda_param_name(param) for param in params.split(','))


def parse_cuda_kernel_params(source_text):
    return {
        match.group(1): _split_cuda_params(match.group(2))
        for match in re.finditer(r'extern\s+"C"\s+__global__\s+void\s+(\w+)\s*\((.*?)\)\s*\{', source_text, re.S)
    }


def _base_param_name(name):
    if name.endswith('_arg'):
        name = name[:-4]
    return PARAM_NAME_ALIASES.get(name, name)


def _canonical_builder_param(builder_name, name):
    if name.endswith('_arg'):
        name = name[:-4]
    return _base_param_name(BUILDER_PARAM_ALIASES.get((builder_name, name), name))


def _canonical_kernel_param(symbol, name):
    if name.endswith('_arg'):
        name = name[:-4]
    return _base_param_name(KERNEL_PARAM_ALIASES.get((symbol, name), name))


def _pointer_array_signature(return_value):
    if not isinstance(return_value, ast.Call) or not isinstance(return_value.func, ast.BinOp):
        return None
    array_type = return_value.func
    if not isinstance(array_type.op, ast.Mult):
        return None
    if not (
        isinstance(array_type.left, ast.Attribute)
        and isinstance(array_type.left.value, ast.Name)
        and array_type.left.value.id == 'ctypes'
        and array_type.left.attr == 'c_void_p'
        and isinstance(array_type.right, ast.Constant)
        and isinstance(array_type.right.value, int)
    ):
        return None
    names = []
    for arg in return_value.args:
        if not (
            isinstance(arg, ast.Call)
            and isinstance(arg.func, ast.Name)
            and arg.func.id == 'ptr_arg'
            and len(arg.args) == 1
            and isinstance(arg.args[0], ast.Name)
        ):
            return None
        names.append(arg.args[0].id)
    return array_type.right.value, tuple(names)


def _builder_pointer_signatures(kernel_args_path):
    module = ast.parse(Path(kernel_args_path).read_text())
    signatures = {}
    errors = []
    for node in module.body:
        if not isinstance(node, ast.FunctionDef) or not node.name.startswith('build_'):
            continue
        function_signatures = []
        for child in ast.walk(node):
            if not isinstance(child, ast.Return):
                continue
            parsed = _pointer_array_signature(child.value)
            if parsed is None:
                continue
            declared_arity, names = parsed
            if declared_arity != len(names):
                errors.append(
                    f'CUDA ABI builder {node.name} declares {declared_arity} pointers but returns {len(names)}'
                )
            function_signatures.append(names)
        if function_signatures:
            signatures[node.name] = tuple(dict.fromkeys(function_signatures))
    return signatures, errors


def _manifest_spec_attrs(manifest_path):
    module = ast.parse(Path(manifest_path).read_text())
    attrs = set()
    for node in ast.walk(module):
        if not isinstance(node, ast.Call):
            continue
        if not isinstance(node.func, ast.Name) or node.func.id != '_spec':
            continue
        if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
            attrs.add(node.args[0].value)
    return attrs


def validate_cuda_kernel_abi(source_text=None, source_path=None):
    runtime_bin = Path(__file__).resolve().parent
    source_path = Path(source_path) if source_path is not None else DEFAULT_CUDA_SOURCE
    if source_text is None:
        source_text = read_cuda_source_with_local_includes(source_path)
    parsed_params = parse_cuda_kernel_params(source_text)
    errors = []

    missing_symbols = [symbol for symbol in CUDA_KERNEL_SYMBOLS if symbol not in parsed_params]
    if missing_symbols:
        errors.append('CUDA source is missing manifest symbols: ' + ', '.join(missing_symbols))
    unregistered_symbols = sorted(set(parsed_params) - set(CUDA_KERNEL_SYMBOLS))
    if unregistered_symbols:
        errors.append('CUDA source has unregistered kernel symbols: ' + ', '.join(unregistered_symbols))

    missing_builder_specs = [symbol for symbol in CUDA_KERNEL_SYMBOLS if symbol not in KERNEL_ARG_BUILDERS]
    if missing_builder_specs:
        errors.append('CUDA ABI builder registry is missing manifest symbols: ' + ', '.join(missing_builder_specs))
    unknown_builder_specs = sorted(set(KERNEL_ARG_BUILDERS) - set(CUDA_KERNEL_SYMBOLS))
    if unknown_builder_specs:
        errors.append('CUDA ABI builder registry has unknown symbols: ' + ', '.join(unknown_builder_specs))

    builder_signatures, builder_errors = _builder_pointer_signatures(runtime_bin / 'kernel_args.py')
    errors.extend(builder_errors)
    for symbol, builder_name in KERNEL_ARG_BUILDERS.items():
        source_params = parsed_params.get(symbol)
        if source_params is None:
            continue
        candidates = builder_signatures.get(builder_name)
        if not candidates:
            errors.append(f'CUDA ABI builder {builder_name} for {symbol} is missing or returns no ctypes pointer array')
            continue
        same_arity = [candidate for candidate in candidates if len(candidate) == len(source_params)]
        if not same_arity:
            errors.append(
                f'CUDA ABI arity mismatch for {symbol}: source has {len(source_params)} params, '
                f'{builder_name} builds {sorted({len(candidate) for candidate in candidates})} args'
            )
            continue
        canonical_source = tuple(_canonical_kernel_param(symbol, name) for name in source_params)
        canonical_candidates = [
            tuple(_canonical_builder_param(builder_name, name) for name in candidate)
            for candidate in same_arity
        ]
        if len(set(canonical_source)) != len(canonical_source):
            errors.append(f'CUDA ABI source aliases collapse distinct params for {symbol}: {source_params}')
            continue
        collapsed_candidate = next(
            (candidate for candidate in canonical_candidates if len(set(candidate)) != len(candidate)),
            None,
        )
        if collapsed_candidate is not None:
            errors.append(f'CUDA ABI builder aliases collapse distinct params for {builder_name}: {collapsed_candidate}')
            continue
        if canonical_source not in canonical_candidates:
            errors.append(
                f'CUDA ABI argument order mismatch for {symbol}: source has {source_params}, '
                f'{builder_name} builds {same_arity}'
            )

    duplicate_attrs = sorted({attr for attr in KERNEL_HANDLE_ATTRS if KERNEL_HANDLE_ATTRS.count(attr) > 1})
    if duplicate_attrs:
        errors.append('CUDA kernel handle attrs contain duplicates: ' + ', '.join(duplicate_attrs))

    unknown_spec_attrs = sorted(_manifest_spec_attrs(runtime_bin / 'cuda_kernel_manifest.py') - set(KERNEL_HANDLE_ATTRS))
    if unknown_spec_attrs:
        errors.append('CUDA kernel load specs use attrs absent from KERNEL_HANDLE_ATTRS: ' + ', '.join(unknown_spec_attrs))

    if errors:
        raise RuntimeError('CUDA ABI validation failed:\n- ' + '\n- '.join(errors))
    return parsed_params


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    source_path = Path(argv[0]) if argv else DEFAULT_CUDA_SOURCE
    parsed = validate_cuda_kernel_abi(source_path=source_path)
    print(f'CUDA ABI validation passed: symbols={len(CUDA_KERNEL_SYMBOLS)} source_kernels={len(parsed)} builders={len(KERNEL_ARG_BUILDERS)}')


if __name__ == '__main__':
    main()
