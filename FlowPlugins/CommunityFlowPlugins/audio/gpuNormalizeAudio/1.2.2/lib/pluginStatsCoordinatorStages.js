"use strict";

const {
  createPluginCpuLoudnormContext,
} = require("./pluginCpuLoudnormContext");
const {
  createPluginSplitStatsContext,
} = require("./pluginSplitStatsContext");
const {
  createProcessingOrder,
} = require("./processingOrder");

function createStatsProcessingOrderStage({
  audioPlans,
  useGpuSourcePort,
  gpuFirstPassMeasure,
}) {
  return createProcessingOrder({
    audioPlans,
    useGpuSourcePort,
    gpuFirstPassMeasure,
  });
}

function createCpuLoudnormCoordinatorStage({
  args,
  debugLogging,
  useGpuSourcePort,
  gpuFirstPassMeasure,
  gpuFirstPassAudit,
  pairCpuLoudnormMeasure,
  audioPlans,
  needsInlineStereoDownmix,
  runChecked,
  wrapRuntimeProfile,
  buildGpuFirstPassMeasure,
  buildCpuLoudnormMeasure,
  buildPairedCpuLoudnormMeasure,
  processingSampleRateFor,
  statsCachePathFor,
  sourceChannelsFor,
  planLabelFor,
  loudnessSummary,
  canFuseAnyCpuLoudnormWithSplitStats,
  processingPlans,
}) {
  return createPluginCpuLoudnormContext({
    args,
    debugLogging,
    useGpuSourcePort,
    gpuFirstPassMeasure,
    gpuFirstPassAudit,
    pairCpuLoudnormMeasure,
    audioPlans,
    needsInlineStereoDownmix,
    runChecked,
    wrapRuntimeProfile,
    buildGpuFirstPassMeasure,
    buildCpuLoudnormMeasure,
    buildPairedCpuLoudnormMeasure,
    processingSampleRateFor,
    statsCachePathFor,
    sourceChannelsFor,
    planLabelFor,
    loudnessSummary,
    canFuseAnyCpuLoudnormWithSplitStats,
    processingPlans,
  });
}

function createSplitStatsCoordinatorStage({
  args,
  debugLogging,
  useGpuSourcePort,
  useStreamingSourcePort,
  gpuFirstPassMeasure,
  audioPlans,
  processingOrderContext,
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
  cpuLoudnormContext,
}) {
  const {
    fallbackPlans,
    processingOrder,
    processingPlans,
  } = processingOrderContext;
  const {
    cpuLoudnormKey,
    cpuLoudnormResults,
    cpuLoudnormTasks,
    knownCpuLoudnormValues,
    startCpuLoudnormTask,
  } = cpuLoudnormContext;

  return createPluginSplitStatsContext({
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
  });
}

module.exports = {
  createCpuLoudnormCoordinatorStage,
  createSplitStatsCoordinatorStage,
  createStatsProcessingOrderStage,
};
