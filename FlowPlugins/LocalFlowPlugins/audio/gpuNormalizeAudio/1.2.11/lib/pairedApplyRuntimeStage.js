"use strict";

const {
  buildPairedApplyDirectMuxContext,
} = require("./pairedApplyDirectMuxContext");
const {
  buildPairedApplyRuntimeShellContext,
} = require("./pairedApplyRuntimeShellContext");
const {
  buildPairedApplyRuntimePlans,
} = require("./pairedApplyRuntimePlans");
const {
  runPairedApplyRuntime,
} = require("./pairedApplyRuntimeRunner");
const {
  resolvePairedApplyStrategy,
} = require("./pairedApplyStrategy");

async function runPairedApplyRuntimeStage({
  args,
  debugLogging,
  pairedApplyConfig,
  fallbackPlan,
  originalPlan,
  fallbackPrep,
  originalPrep,
  fallbackLabel,
  originalLabel,
  progressBase,
  audioPlans,
  skippedAudioPlans,
  audioStreams,
  container,
  tmpOutputFilePath,
  pythonPath,
  audioBitrate,
  rawInputAudioArgs,
  encodeSampleRateArgsFor,
  encodeThreadArgs,
  canSkipOriginalAformat,
  processingSampleRateFor,
  buildStreamingEncodeCommand,
  buildStreamingGpuPlan,
  buildPairedStreamingGpuPlan,
  wrapRuntimeProfile,
  runShell,
  updateProgress,
}) {
  const fallbackValues = fallbackPrep.cpuLoudnormValues;
  const originalValues = originalPrep.cpuLoudnormValues;
  const pairedApplyStrategy = resolvePairedApplyStrategy(pairedApplyConfig);
  const {
    directMuxCommand,
    directMuxCompletesOutput,
    directMuxEnabled,
    directMuxFdWrites,
    directMuxInputPlans,
    directMuxPipeFds,
    fallbackEncodeCommand,
    originalEncodeCommand,
  } = buildPairedApplyDirectMuxContext({
    args,
    pairedApplyConfig,
    pairedApplyStrategy,
    fallbackPlan,
    originalPlan,
    fallbackValues,
    originalValues,
    audioPlans,
    skippedAudioPlans,
    audioStreams,
    container,
    tmpOutputFilePath,
    pythonPath,
    audioBitrate,
    rawInputAudioArgs,
    encodeSampleRateArgsFor,
    encodeThreadArgs,
    buildStreamingEncodeCommand,
  });
  const {
    fallbackGpuPlanCommand,
    fallbackRate,
    originalGpuPlanCommand,
    originalRate,
    singleRuntimeGpuPlan,
  } = buildPairedApplyRuntimePlans({
    pairedApplyStrategy,
    fallbackPlan,
    originalPlan,
    fallbackValues,
    originalValues,
    fallbackPrep,
    originalPrep,
    fallbackEncodeCommand,
    originalEncodeCommand,
    processingSampleRateFor,
    buildStreamingGpuPlan,
    buildPairedStreamingGpuPlan,
    wrapRuntimeProfile,
  });
  const script = buildPairedApplyRuntimeShellContext({
    args,
    pairedApplyConfig,
    pairedApplyStrategy,
    fallbackPlan,
    originalPlan,
    audioPlans,
    directMuxEnabled,
    directMuxCommand,
    directMuxFdWrites,
    directMuxPipeFds,
    fallbackRate,
    originalRate,
    fallbackGpuPlanCommand,
    originalGpuPlanCommand,
    singleRuntimeGpuPlan,
    canSkipOriginalAformat,
    pythonPath,
  });
  await runPairedApplyRuntime({
    args,
    debugLogging,
    pairStereoFallbackApplyShellProfile: pairedApplyStrategy.runtime.shellProfile,
    fallbackPlan,
    originalPlan,
    fallbackLabel,
    originalLabel,
    progressBase,
    script,
    runShell,
    updateProgress,
  });

  return {
    directMuxCompletesOutput,
    directMuxEnabled,
  };
}

module.exports = {
  runPairedApplyRuntimeStage,
};
