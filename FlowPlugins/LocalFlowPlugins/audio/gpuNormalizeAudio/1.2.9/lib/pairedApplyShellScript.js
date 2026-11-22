"use strict";

const path = require("path");

const {
  q,
} = require("./common");
const {
  buildPairedApplyOrchestratorPlan,
} = require("./pairedApplyOrchestratorPlan");

const DEFAULT_ORCHESTRATOR = path.join(__dirname, "..", "runtime", "bin", "paired_apply_orchestrator.py");

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
  directMuxPipeFds = {},
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
  const plan = buildPairedApplyOrchestratorPlan({
    singleRuntime,
    shellProfile,
    fallbackPlan,
    originalPlan,
    pairFifos,
    pipeSizerCommands,
    directMuxEnabled,
    directMuxCommand,
    directMuxFdWrites,
    directMuxPipeFds,
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
  });
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
