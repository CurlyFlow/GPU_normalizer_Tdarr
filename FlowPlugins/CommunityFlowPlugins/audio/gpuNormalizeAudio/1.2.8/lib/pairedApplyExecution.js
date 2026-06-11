"use strict";

const {
  finishPairedApplyExecution,
} = require("./pairedApplyCompletion");
const {
  createPairedApplyPrepTasks,
  preparePairedApplyPair,
} = require("./pairedApplyPrepPair");
const {
  runFirstReadyPairedApply,
} = require("./pairedApplyFirstReady");
const {
  runPairedApplyRuntimeStage,
} = require("./pairedApplyRuntimeStage");

async function runPairedFallbackApplyPlan({
  args,
  debugLogging,
  pairedApplyConfig,
  fallbackPlan,
  originalPlan,
  progressBase,
  markDirectMuxCompleted,
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
}) {
  const {
    pairStereoFallbackApplyFirstReady,
    pairStereoFallbackApplyOriginalNice,
    pairStereoFallbackApplyOriginalFirstRuntime,
    pairStereoFallbackApplyPersistentRuntime,
    pairStereoFallbackApplySingleRuntime,
    pairStereoFallbackApplyStereoNice,
  } = pairedApplyConfig;
  const pairStartedAt = Date.now();
  const fallbackLabel = planLabelFor(fallbackPlan);
  const originalLabel = planLabelFor(originalPlan);
  args.jobLog(`GPU normalize paired apply enabled for ${fallbackLabel} + ${originalLabel}${pairStereoFallbackApplySingleRuntime ? " (single runtime)" : ""}${pairStereoFallbackApplyOriginalFirstRuntime ? " (original runtime first)" : ""}`);
  if (pairStereoFallbackApplyFirstReady || pairStereoFallbackApplyPersistentRuntime) {
    const { fallbackPrepPromise, originalPrepPromise } = createPairedApplyPrepTasks({
      args,
      debugLogging,
      fallbackPlan,
      originalPlan,
      progressBase,
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
      skipSplitStats: pairStereoFallbackApplyPersistentRuntime,
      updateProgress,
    });
    const firstReadyResult = await runFirstReadyPairedApply({
      args,
      debugLogging,
      fallbackPlan,
      originalPlan,
      fallbackPrepPromise,
      originalPrepPromise,
      originalNice: pairStereoFallbackApplyOriginalNice,
      progressBase,
      stereoNice: pairStereoFallbackApplyStereoNice,
      buildStreamingDecodeCommand,
      buildStreamingEncodeCommand,
      buildStreamingGpuPlan,
      persistentStatsToApply: pairStereoFallbackApplyPersistentRuntime,
      wrapRuntimeProfile,
      runShell,
      updateProgress,
    });
    if (firstReadyResult.copyOriginalReason) return { copyOriginalReason: firstReadyResult.copyOriginalReason };
    await finishPairedApplyExecution({
      args,
      directMuxEnabled: false,
      fallbackPlan,
      originalPlan,
      fallbackLabel,
      originalLabel,
      pairStartedAt,
      markDirectMuxCompleted,
      pairedApplyCompleted,
      cleanupFilesForPlan,
      runChecked,
    });
    return { copyOriginalReason: "" };
  }
  const { fallbackPrep, gate, originalPrep } = await preparePairedApplyPair({
    args,
    debugLogging,
    fallbackPlan,
    originalPlan,
    progressBase,
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
  });
  if (gate) return gate;

  const runtimeResult = await runPairedApplyRuntimeStage({
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
  });
  if (runtimeResult.copyOriginalReason) return { copyOriginalReason: runtimeResult.copyOriginalReason };
  await finishPairedApplyExecution({
    args,
    directMuxEnabled: runtimeResult.directMuxCompletesOutput,
    fallbackPlan,
    originalPlan,
    fallbackLabel,
    originalLabel,
    pairStartedAt,
    markDirectMuxCompleted,
    pairedApplyCompleted,
    cleanupFilesForPlan,
    runChecked,
  });
  return { copyOriginalReason: "" };
}

module.exports = {
  runPairedFallbackApplyPlan,
};
