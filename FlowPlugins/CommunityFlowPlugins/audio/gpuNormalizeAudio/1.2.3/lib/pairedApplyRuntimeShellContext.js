"use strict";

const {
  buildDecodeRelayCommands,
  buildDualDecodeCommand,
  buildPairedApplyShellScript,
  buildPipeSizerCommands,
} = require("./pairedApply");

function buildPairedApplyRuntimeShellContext({
  args,
  pairedApplyConfig,
  pairedApplyStrategy,
  fallbackPlan,
  originalPlan,
  audioPlans,
  directMuxEnabled,
  directMuxCommand,
  fallbackRate,
  originalRate,
  fallbackGpuPlanCommand,
  originalGpuPlanCommand,
  singleRuntimeGpuPlan,
  canSkipOriginalAformat,
  pythonPath,
}) {
  const { decode, pipes, runtime } = pairedApplyStrategy;

  const fallbackDecodeInput = decode.relayEnabled ? `${fallbackPlan.fifoInput}.relay` : fallbackPlan.fifoInput;
  const originalDecodeInput = decode.relayEnabled ? `${originalPlan.fifoInput}.relay` : originalPlan.fifoInput;
  const originalRawFilter = canSkipOriginalAformat(originalPlan) ? "anull" : `aformat=channel_layouts=${originalPlan.channelLayout}`;
  const dualDecode = buildDualDecodeCommand({
    ffmpegPath: args.ffmpegPath,
    sourceInput: fallbackPlan.sourceInput,
    sourceAudioIdx: fallbackPlan.sourceAudioIdx,
    originalRawFilter,
    originalFirstDecode: decode.originalFirst,
    originalPlan,
    fallbackPlan,
    originalRate,
    fallbackRate,
    originalDecodeInput,
    fallbackDecodeInput,
    decodeFilterThreads: decode.filterThreads,
  });
  const pairFifos = directMuxEnabled
    ? [fallbackPlan.fifoInput, originalPlan.fifoInput, ...audioPlans.map((plan) => plan.fifoOutput)]
    : [fallbackPlan.fifoInput, originalPlan.fifoInput];
  if (decode.relayEnabled) pairFifos.push(fallbackDecodeInput, originalDecodeInput);
  const { fallbackDecodeRelayCommand, originalDecodeRelayCommand } = buildDecodeRelayCommands({
    enabled: decode.relayEnabled,
    pythonPath,
    relayMiB: decode.relayMiB,
    fallbackDecodeInput,
    originalDecodeInput,
    fallbackPlan,
    originalPlan,
  });
  const pipeSizerCommands = buildPipeSizerCommands({
    pythonPath,
    pipeMiB: pipes.inputMiB,
    fallbackPlan,
    originalPlan,
  });
  return buildPairedApplyShellScript({
    singleRuntime: runtime.single,
    shellProfile: runtime.shellProfile,
    fallbackPlan,
    originalPlan,
    pairFifos,
    pipeSizerCommands,
    directMuxEnabled,
    directMuxCommand,
    pythonPath,
    runtimeNoTee: runtime.noTee,
    runtimeOriginalFirst: runtime.originalFirst,
    runtimeStereoDelayMs: runtime.stereoDelayMs,
    singleRuntimeGpuPlan,
    dualDecode,
    decodeRelayEnabled: decode.relayEnabled,
    fallbackDecodeRelayCommand,
    originalDecodeRelayCommand,
    fallbackRuntimeCommand: fallbackGpuPlanCommand,
    originalRuntimeCommand: originalGpuPlanCommand,
  });
}

module.exports = {
  buildPairedApplyRuntimeShellContext,
};
