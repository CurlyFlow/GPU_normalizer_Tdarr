import time

from cuda_launch import launch_kernel, launch_timed_kernel


def launch_apply_kernel(ctx, profile_label, kernel_fn, launch_args, *, grid_x=1, block_x=1, check_label=None):
    if ctx.cfg.exact.exact_apply_fast_launch:
        t0 = time.perf_counter()
        launch_kernel(ctx.cuda, profile_label, kernel_fn, launch_args, grid_x=grid_x, block_x=block_x, check_label=check_label)
        return time.perf_counter() - t0
    return launch_timed_kernel(ctx.cuda, profile_label, kernel_fn, launch_args, grid_x=grid_x, block_x=block_x, check_label=check_label)


def record_safe_apply_kernel(result, seconds):
    result.apply_kernel_time += seconds
    result.exact_safe_kernel_time += seconds
    result.exact_safe_apply_kernel_time += seconds


def record_unsafe_apply_kernel(result, seconds):
    result.apply_kernel_time += seconds
    result.exact_unsafe_kernel_time += seconds
    result.exact_unsafe_apply_kernel_time += seconds
