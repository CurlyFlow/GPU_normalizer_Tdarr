"use strict";

const {
  createPairedApplyConfig,
} = require("./pairedApplyConfig");
const {
  runPairedFallbackApplyPlan,
} = require("./pairedApplyExecution");

function createPairedApplyCoordinator({
  args,
  debugLogging,
  useGpuSourcePort,
  useStreamingSourcePort,
  audioPlans,
  skippedAudioPlans,
  audioStreams,
  container,
  tmpOutputFilePath,
  pythonPath,
  targetI,
  maxGain,
  durationSeconds,
  audioBitrate,
  rawInputAudioArgs,
  encodeSampleRateArgsFor,
  encodeThreadArgs,
  canSkipOriginalAformat,
  processingSampleRateFor,
  needsInlineStereoDownmix,
  usesStereoFallbackSourcePath,
  canSplitStatsPlan,
  canFuseAnyCpuLoudnormWithSplitStats,
  startCpuLoudnormTask,
  startSplitStatsTask,
  getCpuLoudnormRecord,
  buildStreamingDecodeCommand,
  buildStreamingEncodeCommand,
  buildStreamingGpuPlan,
  buildPairedStreamingGpuPlan,
  wrapRuntimeProfile,
  runShell,
  runChecked,
  cleanupFilesForPlan,
  planLabelFor,
  updateProgress,
}) {
  const pairedApplyConfig = createPairedApplyConfig({ args, useGpuSourcePort, useStreamingSourcePort });
  const {
    pairStereoFallbackApply,
  } = pairedApplyConfig;
  let pairedDirectMuxCompleted = false;
  const pairedApplyCompleted = new Set();

  const canPairFallbackAndOriginal = (fallbackPlan, originalPlan) => {
    if (!fallbackPlan || !originalPlan || !fallbackPlan.stereoFallback || originalPlan.stereoFallback) return false;
    if (!usesStereoFallbackSourcePath(fallbackPlan)) return false;
    if (fallbackPlan.sourceIdx !== originalPlan.sourceIdx) return false;
    if (!originalPlan.channelLayout) return false;
    if (!canSplitStatsPlan(fallbackPlan) || !canSplitStatsPlan(originalPlan)) return false;
    if (fallbackPlan.rawInputFormat !== originalPlan.rawInputFormat || fallbackPlan.rawGpuFormat !== originalPlan.rawGpuFormat) return false;
    return true;
  };

  const pairedFallbackApplyPartner = (plan) => {
    if (!pairStereoFallbackApply || !plan.stereoFallback) return null;
    const partner = audioPlans.find((candidate) => !candidate.stereoFallback && candidate.sourceIdx === plan.sourceIdx);
    return canPairFallbackAndOriginal(plan, partner) ? partner : null;
  };

  const runPairedFallbackApply = async (fallbackPlan, originalPlan, progressBase) => {
    return await runPairedFallbackApplyPlan({
      args,
      debugLogging,
      pairedApplyConfig,
      fallbackPlan,
      originalPlan,
      progressBase,
      markDirectMuxCompleted: () => {
        pairedDirectMuxCompleted = true;
      },
      pairedApplyCompleted,
      durationSeconds,
      canSplitStatsPlan,
      canFuseAnyCpuLoudnormWithSplitStats,
      startCpuLoudnormTask,
      startSplitStatsTask,
      getCpuLoudnormRecord,
      processingSampleRateFor,
      planLabelFor,
      targetI,
      maxGain,
      updateProgress,
      audioPlans,
      skippedAudioPlans,
      audioStreams,
      container,
      tmpOutputFilePath,
      pythonPath,
      audioBitrate,
      rawInputAudioArgs,
      buildStreamingDecodeCommand,
      encodeSampleRateArgsFor,
      encodeThreadArgs,
      canSkipOriginalAformat,
      buildStreamingEncodeCommand,
      buildStreamingGpuPlan,
      buildPairedStreamingGpuPlan,
      wrapRuntimeProfile,
      runShell,
      runChecked,
      cleanupFilesForPlan,
    });
  };

  return {
    isPairedDirectMuxCompleted: () => pairedDirectMuxCompleted,
    pairStereoFallbackApply,
    pairedApplyCompleted,
    pairedFallbackApplyPartner,
    runPairedFallbackApply,
  };
}

module.exports = {
  createPairedApplyCoordinator,
};
