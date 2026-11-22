"use strict";

const {
  finishPairedApplyExecution,
} = require("./pairedApplyCompletion");
const {
  runFirstReadyPairedApply,
} = require("./pairedApplyFirstReady");
const {
  createPairedApplyPrepTasks,
  preparePairedApplyPair,
} = require("./pairedApplyPrepTasks");
const {
  runPairedApplyRuntimeStage,
} = require("./pairedApplyRuntimeStage");
const {
  resolvePairedApplyStrategy,
} = require("./pairedApplyStrategy");

async function runPairedFallbackApplyPlan({
  context,
  pairedApplyConfig,
  fallbackPlan,
  originalPlan,
  progressBase,
  markDirectMuxCompleted,
  pairedApplyCompleted,
  skipNormalization,
}) {
  const { model, runtimeContext, statsContext, commandBuilders } = context;
  const { args, runShell } = model.core;
  const { debugLogging, audioStreams } = model.preflight;
  const { targetI, maxGain, audioBitrate, encodeThreadArgs } = model.runtimeConfig.audioConfig;
  const { durationSeconds, audioCompatibilityContainer: container, tmpOutputFilePath } = model.runtimeConfig.outputPathConfig;
  const { pythonPath } = model.runtimeConfig.runtimePathConfig;
  const { planLabelFor, updateProgress, audioPlans, skippedAudioPlans, cleanupFilesForPlan } = model.planSetup;
  const {
    processingSampleRateFor, rawInputAudioArgs, encodeSampleRateArgsFor, canSkipOriginalAformat,
    buildStreamingGpuPlan, buildPairedStreamingGpuPlan, wrapRuntimeProfile, runChecked,
  } = runtimeContext;
  const {
    canSplitStatsPlan, canFuseAnyCpuLoudnormWithSplitStats, startCpuLoudnormTask,
    startSplitStatsTask, getCpuLoudnormRecord,
  } = statsContext;
  const { buildStreamingDecodeCommand, buildStreamingEncodeCommand } = commandBuilders;
  const pairedApplyStrategy = resolvePairedApplyStrategy(pairedApplyConfig);
  const { nice, runtime } = pairedApplyStrategy;
  const pairStartedAt = Date.now();
  const fallbackLabel = planLabelFor(fallbackPlan);
  const originalLabel = planLabelFor(originalPlan);
  args.jobLog(`GPU normalize paired apply enabled for ${fallbackLabel} + ${originalLabel}${runtime.single ? " (single runtime)" : ""}${runtime.originalFirst ? " (original runtime first)" : ""}`);
  if (runtime.firstReady || runtime.persistentRuntime) {
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
      skipSplitStats: runtime.persistentRuntime,
      updateProgress,
    });
    await runFirstReadyPairedApply({
      args,
      debugLogging,
      fallbackPlan,
      originalPlan,
      fallbackPrepPromise,
      originalPrepPromise,
      originalNice: nice.original,
      progressBase,
      stereoNice: nice.fallback,
      buildStreamingDecodeCommand,
      buildStreamingEncodeCommand,
      buildStreamingGpuPlan,
      persistentStatsToApply: runtime.persistentRuntime,
      wrapRuntimeProfile,
      runShell,
      skipNormalization,
      updateProgress,
    });
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
    return { completed: true };
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
  if (gate) return { separateApply: true };

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
  return { completed: true };
}

module.exports = {
  runPairedFallbackApplyPlan,
};
