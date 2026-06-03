"use strict";

const path = require("path");

const {
  q,
} = require("./common");

const DEFAULT_ORCHESTRATOR = path.join(__dirname, "..", "runtime", "bin", "paired_apply_orchestrator.py");
const PAIRED_APPLY_PLAN_SCHEMA = "gpuNormalizeAudio.pairedApplyPlan.v1";

function buildPairedApplyShellScript({
  singleRuntime,
  shellProfile,
  fallbackPlan,
  originalPlan,
  pairFifos,
  pipeSizerCommands,
  directMuxEnabled,
  directMuxCommand,
  directMuxFdWrites = {},
  pythonPath,
  orchestratorPath = DEFAULT_ORCHESTRATOR,
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
  const runtimeOrder = runtimeOriginalFirst
    ? [
      { runtime: "original" },
      ...(runtimeStereoDelayMs > 0 ? [{ sleepMs: runtimeStereoDelayMs }] : []),
      { runtime: "fallback" },
    ]
    : [{ runtime: "fallback" }, { runtime: "original" }];
  const plan = {
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
  const planJson = JSON.stringify(plan);
  return [
    "set -o pipefail",
    "plan_file=$(mktemp \"${TMPDIR:-/tmp}/gpu-normalize-paired-apply.XXXXXX.json\")",
    "cleanup_plan(){ rm -f \"$plan_file\"; }",
    "trap cleanup_plan EXIT",
    "cat > \"$plan_file\" <<'__LOUDNORM_PAIRED_APPLY_PLAN__'",
    planJson,
    "__LOUDNORM_PAIRED_APPLY_PLAN__",
    `${q(pythonPath)} ${q(orchestratorPath)} "$plan_file"`,
    "code=$?",
    "trap - EXIT",
    "cleanup_plan",
    "exit $code",
  ].join("\n");
}

module.exports = {
  buildPairedApplyShellScript,
};
