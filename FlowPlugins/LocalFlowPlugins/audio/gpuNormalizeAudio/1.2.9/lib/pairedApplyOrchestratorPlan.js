"use strict";

const PAIRED_APPLY_PLAN_SCHEMA = "gpuNormalizeAudio.pairedApplyPlan.v1";

function runtimeOrderFor({ runtimeOriginalFirst, runtimeStereoDelayMs }) {
  return runtimeOriginalFirst
    ? [
      { runtime: "original" },
      ...(runtimeStereoDelayMs > 0 ? [{ sleepMs: runtimeStereoDelayMs }] : []),
      { runtime: "fallback" },
    ]
    : [{ runtime: "fallback" }, { runtime: "original" }];
}

function buildPairedApplyOrchestratorPlan({
  singleRuntime,
  shellProfile,
  fallbackPlan,
  originalPlan,
  pairFifos,
  pipeSizerCommands,
  directMuxEnabled,
  directMuxCommand,
  directMuxFdWrites = {},
  directMuxPipeFds = {},
  runtimeNoTee,
  runtimeOriginalFirst,
  runtimeStereoDelayMs,
  singleRuntimeGpuPlan,
  dualDecode,
  decodeRelayEnabled,
  fallbackDecodeRelayCommand,
  originalDecodeRelayCommand,
  fallbackRuntimeCommand,
  originalRuntimeCommand,
}) {
  const profileFields = `stream=${fallbackPlan.idx} partner_stream=${originalPlan.idx} source_stream=${fallbackPlan.sourceIdx} channels=${fallbackPlan.channels}+${originalPlan.channels}`;
  const runtimeOrder = runtimeOrderFor({ runtimeOriginalFirst, runtimeStereoDelayMs });
  return {
    schema: PAIRED_APPLY_PLAN_SCHEMA,
    topology: singleRuntime ? "single_runtime" : "dual_runtime",
    decodeRelay: {
      enabled: decodeRelayEnabled,
      fallback: { command: fallbackDecodeRelayCommand, errPath: fallbackPlan.sourceErr },
      original: { command: originalDecodeRelayCommand, errPath: originalPlan.sourceErr },
    },
    directMux: {
      command: directMuxCommand,
      enabled: directMuxEnabled,
      errPath: fallbackPlan.sourceErr,
      fdWrites: directMuxFdWrites,
      pipeFds: directMuxPipeFds,
    },
    dualDecodeCommand: dualDecode,
    fifoPaths: pairFifos,
    pipeSizerCommands,
    profileFields,
    runtimeOrder,
    runtimes: singleRuntime ? {
      single: {
        command: singleRuntimeGpuPlan,
        emitStdout: true,
        teePaths: [fallbackPlan.sourceErr, originalPlan.sourceErr],
      },
    } : {
      fallback: {
        command: fallbackRuntimeCommand,
        emitStdout: !runtimeNoTee,
        teePaths: [fallbackPlan.sourceErr],
      },
      original: {
        command: originalRuntimeCommand,
        emitStdout: !runtimeNoTee,
        teePaths: [originalPlan.sourceErr],
      },
    },
    shellProfile,
    singleRuntime,
  };
}

module.exports = {
  PAIRED_APPLY_PLAN_SCHEMA,
  buildPairedApplyOrchestratorPlan,
};
