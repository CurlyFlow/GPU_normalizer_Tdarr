"use strict";

const {
  createSplitStatsConfig,
} = require("./splitStatsConfig");
const {
  createSplitStatsPolicy,
} = require("./splitStatsPolicy");
const {
  createSplitStatsTaskStarters,
} = require("./splitStatsTaskStarters");

function createSplitStatsCoordinator({
  args,
  debugLogging,
  useGpuSourcePort,
  useStreamingSourcePort,
  gpuFirstPassMeasure,
  fallbackPlans,
  audioPlans,
  processingPlans,
  processingOrder,
  needsInlineStereoDownmix,
  usesStereoFallbackSourcePath,
  processingSampleRateFor,
  trackStatsPaths,
  buildStatsRuntimePlan,
  loudnormFilter,
  decodeAudioArgs,
  runShell,
  wrapRuntimeProfile,
  planLabelFor,
  cpuLoudnormResults,
  cpuLoudnormTasks,
  cpuLoudnormKey,
  knownCpuLoudnormValues,
  startCpuLoudnormTask,
}) {
  const splitStatsTasks = new Map();
  const splitStatsResults = new Map();

  const splitStatsConfig = createSplitStatsConfig({
    args,
    fallbackPlans,
  });
  const {
    pairStereoFallbackSplitStatsFuseMeasure,
    pairStereoFallbackSplitStatsSinglePipe,
    pairStereoFallbackSplitStatsSingleRuntime,
    pairStereoFallbackSplitStatsStdoutPrimary,
    pairStereoFallbackSplitStatsStereoPrimary,
    splitPrefetchNextStatsAtProgress,
    splitPrefetchNextStatsDuringStats,
  } = splitStatsConfig;

  const {
    canFuseAnyCpuLoudnormWithSplitStats,
    canFuseCpuLoudnormWithSplitStats,
    canFuseOriginalCpuLoudnormWithSplitStats,
    canSplitStatsPlan,
    createPrefetchNextSplitStats,
    pairedSplitStatsPartner,
    splitStatsKey,
  } = createSplitStatsPolicy({
    splitStatsConfig,
    useGpuSourcePort,
    useStreamingSourcePort,
    gpuFirstPassMeasure,
    fallbackPlans,
    audioPlans,
    processingPlans,
    processingOrder,
    needsInlineStereoDownmix,
    usesStereoFallbackSourcePath,
    knownCpuLoudnormValues,
    startCpuLoudnormTask,
  });

  const startSplitStatsTask = createSplitStatsTaskStarters({
    args,
    debugLogging,
    usesStereoFallbackSourcePath,
    processingSampleRateFor,
    trackStatsPaths,
    buildStatsRuntimePlan,
    loudnormFilter,
    runShell,
    planLabelFor,
    knownCpuLoudnormValues,
    cpuLoudnormResults,
    cpuLoudnormTasks,
    cpuLoudnormKey,
    splitStatsKey,
    splitStatsResults,
    splitStatsTasks,
    pairStereoFallbackSplitStatsSingleRuntime,
    pairStereoFallbackSplitStatsSinglePipe,
    pairStereoFallbackSplitStatsStdoutPrimary,
    pairStereoFallbackSplitStatsStereoPrimary,
    decodeAudioArgs,
    wrapRuntimeProfile,
    canFuseOriginalCpuLoudnormWithSplitStats,
    canFuseAnyCpuLoudnormWithSplitStats,
    pairedSplitStatsPartner,
    pairStereoFallbackSplitStatsFuseMeasure,
  });

  const prefetchNextSplitStats = createPrefetchNextSplitStats(startSplitStatsTask);

  return {
    canFuseAnyCpuLoudnormWithSplitStats,
    canFuseCpuLoudnormWithSplitStats,
    canFuseOriginalCpuLoudnormWithSplitStats,
    canSplitStatsPlan,
    prefetchNextSplitStats,
    splitPrefetchNextStatsDuringStats,
    splitPrefetchNextStatsAtProgress,
    startSplitStatsTask,
  };
}

module.exports = {
  createSplitStatsCoordinator,
};
