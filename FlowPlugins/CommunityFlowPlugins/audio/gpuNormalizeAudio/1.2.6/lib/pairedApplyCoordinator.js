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

  const pairedFallbackApplyPartner = (plan) => {
    if (!pairStereoFallbackApply || !plan.stereoFallback || !usesStereoFallbackSourcePath(plan)) return null;
    const partner = audioPlans.find((candidate) => !candidate.stereoFallback && candidate.sourceIdx === plan.sourceIdx);
    if (!partner || !partner.channelLayout) return null;
    if (!canSplitStatsPlan(plan) || !canSplitStatsPlan(partner)) return null;
    if (plan.rawInputFormat !== partner.rawInputFormat || plan.rawGpuFormat !== partner.rawGpuFormat) return null;
    return partner;
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
