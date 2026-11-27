from __future__ import annotations

from dataclasses import dataclass

from apply_passes import ApplyPassResult
from gain_metrics import GainMetricsResult


@dataclass
class RuntimeModeContext:
    cuda: object
    cuda_session: object
    args: object
    cfg: object
    buffers: object
    kernels: object
    bindings: object
    state_bytes: int
    host_io: object
    b_coeffs: object
    a_coeffs: object


@dataclass
class RuntimeStageResult:
    stats_result: object
    gain_metrics: object = None
    apply_result: object = None


@dataclass
class RuntimeApplyResult:
    gain_metrics: object
    apply_result: object


def idle_apply_stage():
    return RuntimeStageResult(
        stats_result=None,
        gain_metrics=GainMetricsResult(input_i=float('nan'), gain_min_amp=1.0, gain_max_amp=1.0),
        apply_result=ApplyPassResult(),
    )
