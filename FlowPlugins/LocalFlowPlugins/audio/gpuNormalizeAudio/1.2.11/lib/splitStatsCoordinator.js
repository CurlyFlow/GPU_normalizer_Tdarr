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
  cpuLoudnormMeasurementStore,
  cpuLoudnormKey,
  knownCpuLoudnormValues,
  startCpuLoudnormTask,
  splitStatsConfig: providedSplitStatsConfig,
  splitStatsPolicy: providedSplitStatsPolicy,
}) {
  const splitStatsTasks = new Map();
  const splitStatsResults = new Map();

  const splitStatsConfig = providedSplitStatsConfig || createSplitStatsConfig({
    args,
    fallbackPlans,
  });
  const {
    pairStereoFallbackSplitStatsFuseMeasure,
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
  } = providedSplitStatsPolicy || createSplitStatsPolicy({
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
    cpuLoudnormMeasurementStore,
    cpuLoudnormKey,
    splitStatsKey,
    splitStatsResults,
    splitStatsTasks,
    splitStatsConfig,
    decodeAudioArgs,
    wrapRuntimeProfile,
    canFuseOriginalCpuLoudnormWithSplitStats,
    canFuseAnyCpuLoudnormWithSplitStats,
    pairedSplitStatsPartner,
    pairStereoFallbackSplitStatsFuseMeasure,
  });

  const prefetchNextSplitStats = createPrefetchNextSplitStats(startSplitStatsTask, {
    knownCpuLoudnormValues,
    startCpuLoudnormTask,
  });

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
