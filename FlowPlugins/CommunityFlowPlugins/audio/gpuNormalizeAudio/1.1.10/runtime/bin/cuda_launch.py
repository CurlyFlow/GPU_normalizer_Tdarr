from __future__ import annotations

from cuda_driver import chk, cuda_event_elapsed


def launch_timed_kernel(cuda, profile_label, kernel_fn, launch_args, *, grid_x=1, block_x=1, grid_y=1, grid_z=1, block_y=1, block_z=1, shared_mem=0, stream=None, check_label=None):
    label = check_label or f'cuLaunchKernel({profile_label})'
    return cuda_event_elapsed(
        cuda,
        profile_label,
        lambda: chk(
            cuda.cuLaunchKernel(kernel_fn, grid_x, grid_y, grid_z, block_x, block_y, block_z, shared_mem, stream, launch_args, None),
            label,
        ),
    )
