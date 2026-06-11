from __future__ import annotations

from cuda_driver import chk
from cuda_kernel_manifest import load_cuda_kernel_set


def load_kernel_set(cuda, module, args, cfg):
    return load_cuda_kernel_set(cuda, module, args, cfg, chk)
