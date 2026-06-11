"use strict";

const {
  buildPairedApplyRuntimePlan,
} = require("./pairedApplyRuntimePlan");
const {
  runPairedApplyRuntime,
} = require("./pairedApplyRuntimeRunner");

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
  const {
    pairStereoFallbackApplyShellProfile,
  } = pairedApplyConfig;
  const fallbackValues = fallbackPrep.cpuLoudnormValues;
  const originalValues = originalPrep.cpuLoudnormValues;
  const { directMuxCompletesOutput, directMuxEnabled, script } = buildPairedApplyRuntimePlan({
    args,
    pairedApplyConfig,
    fallbackPlan,
    originalPlan,
    fallbackValues,
    originalValues,
    fallbackPrep,
    originalPrep,
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
  });
  const runtimeResult = await runPairedApplyRuntime({
    args,
    debugLogging,
    pairStereoFallbackApplyShellProfile,
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
    copyOriginalReason: runtimeResult.copyOriginalReason,
    directMuxCompletesOutput,
    directMuxEnabled,
  };
}

module.exports = {
  runPairedApplyRuntimeStage,
};
