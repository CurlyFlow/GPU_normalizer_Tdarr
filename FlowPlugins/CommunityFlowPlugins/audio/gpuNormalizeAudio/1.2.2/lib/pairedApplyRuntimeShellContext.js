"use strict";

const {
  q,
} = require("./common");
const {
  buildDecodeRelayCommands,
  buildDualDecodeCommand,
  buildPairedApplyShellScript,
  buildPairedRuntimeLaunchLines,
  buildPipeSizerCommands,
  buildRuntimeLaunchCommand,
} = require("./pairedApply");

function buildPairedApplyRuntimeShellContext({
  args,
  pairedApplyConfig,
  fallbackPlan,
  originalPlan,
  audioPlans,
  directMuxEnabled,
  directMuxInputPlans,
  directMuxCommand,
  fallbackRate,
  originalRate,
  fallbackGpuPlanCommand,
  originalGpuPlanCommand,
  singleRuntimeGpuPlan,
  canSkipOriginalAformat,
  pythonPath,
}) {
  const {
    pairStereoFallbackApplyDecodeFilterThreads,
    pairStereoFallbackApplyDecodeRelay,
    pairStereoFallbackApplyDecodeRelayMiB,
    pairStereoFallbackApplyNoTee,
    pairStereoFallbackApplyOriginalFirstDecode,
    pairStereoFallbackApplyOriginalFirstRuntime,
    pairStereoFallbackApplyOutputPipeMiB,
    pairStereoFallbackApplyPipeMiB,
    pairStereoFallbackApplyShellProfile,
    pairStereoFallbackApplySingleRuntime,
    pairStereoFallbackApplyStereoDelayMs,
  } = pairedApplyConfig;

  const fallbackDecodeInput = pairStereoFallbackApplyDecodeRelay ? `${fallbackPlan.fifoInput}.relay` : fallbackPlan.fifoInput;
  const originalDecodeInput = pairStereoFallbackApplyDecodeRelay ? `${originalPlan.fifoInput}.relay` : originalPlan.fifoInput;
  const originalRawFilter = canSkipOriginalAformat(originalPlan) ? "anull" : `aformat=channel_layouts=${originalPlan.channelLayout}`;
  const dualDecode = buildDualDecodeCommand({
    ffmpegPath: args.ffmpegPath,
    sourceInput: fallbackPlan.sourceInput,
    sourceAudioIdx: fallbackPlan.sourceAudioIdx,
    originalRawFilter,
    originalFirstDecode: pairStereoFallbackApplyOriginalFirstDecode,
    originalPlan,
    fallbackPlan,
    originalRate,
    fallbackRate,
    originalDecodeInput,
    fallbackDecodeInput,
    decodeFilterThreads: pairStereoFallbackApplyDecodeFilterThreads,
  });
  const pairFifos = directMuxEnabled
    ? [fallbackPlan.fifoInput, originalPlan.fifoInput, ...audioPlans.map((plan) => plan.fifoOutput)]
    : [fallbackPlan.fifoInput, originalPlan.fifoInput];
  if (pairStereoFallbackApplyDecodeRelay) pairFifos.push(fallbackDecodeInput, originalDecodeInput);
  const cleanupPair = `rm -f ${pairFifos.map(q).join(" ")}`;
  const { fallbackDecodeRelayCommand, originalDecodeRelayCommand } = buildDecodeRelayCommands({
    enabled: pairStereoFallbackApplyDecodeRelay,
    pythonPath,
    relayMiB: pairStereoFallbackApplyDecodeRelayMiB,
    fallbackDecodeInput,
    originalDecodeInput,
    fallbackPlan,
    originalPlan,
  });
  const pipeSizerCommands = buildPipeSizerCommands({
    pythonPath,
    pipeMiB: pairStereoFallbackApplyPipeMiB,
    outputPipeMiB: pairStereoFallbackApplyOutputPipeMiB,
    directMuxEnabled,
    fallbackPlan,
    originalPlan,
    directMuxInputPlans,
  });
  const fallbackRuntimeLaunch = buildRuntimeLaunchCommand({
    shellProfile: pairStereoFallbackApplyShellProfile,
    profileName: "fallback_runtime",
    command: fallbackGpuPlanCommand,
    sourceErr: fallbackPlan.sourceErr,
    noTee: pairStereoFallbackApplyNoTee,
    pidName: "pid_fallback",
  });
  const originalRuntimeLaunch = buildRuntimeLaunchCommand({
    shellProfile: pairStereoFallbackApplyShellProfile,
    profileName: "original_runtime",
    command: originalGpuPlanCommand,
    sourceErr: originalPlan.sourceErr,
    noTee: pairStereoFallbackApplyNoTee,
    pidName: "pid_original",
  });
  const pairedRuntimeLaunchLines = buildPairedRuntimeLaunchLines({
    originalFirstRuntime: pairStereoFallbackApplyOriginalFirstRuntime,
    stereoDelayMs: pairStereoFallbackApplyStereoDelayMs,
    fallbackRuntimeLaunch,
    originalRuntimeLaunch,
  });

  return buildPairedApplyShellScript({
    singleRuntime: pairStereoFallbackApplySingleRuntime,
    shellProfile: pairStereoFallbackApplyShellProfile,
    fallbackPlan,
    originalPlan,
    cleanupPair,
    pairFifos,
    pipeSizerCommands,
    directMuxEnabled,
    directMuxCommand,
    singleRuntimeGpuPlan,
    dualDecode,
    decodeRelayEnabled: pairStereoFallbackApplyDecodeRelay,
    fallbackDecodeRelayCommand,
    originalDecodeRelayCommand,
    pairedRuntimeLaunchLines,
  });
}

module.exports = {
  buildPairedApplyRuntimeShellContext,
};
