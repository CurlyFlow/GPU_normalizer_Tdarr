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
  buildGpuFirstPassInputMeasure,
  buildGpuFirstPassMeasure,
  buildGpuFirstPassMixedSharedStats,
  buildGpuFirstPassMixedSharedDecode,
  buildGpuFirstPassOutputApplyFromStats,
  buildCpuLoudnormMeasure,
  buildPairedCpuLoudnormMeasure,
  processingSampleRateFor,
  statsCachePathFor,
  trackStatsCachePath,
  sourceChannelsFor,
  planLabelFor,
  loudnessSummary,
  cpuMeasurementAvailability,
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
    buildGpuFirstPassInputMeasure,
    buildGpuFirstPassMeasure,
    buildGpuFirstPassMixedSharedStats,
    buildGpuFirstPassMixedSharedDecode,
    buildGpuFirstPassOutputApplyFromStats,
    buildCpuLoudnormMeasure,
    buildPairedCpuLoudnormMeasure,
    processingSampleRateFor,
    statsCachePathFor,
    trackStatsCachePath,
    sourceChannelsFor,
    planLabelFor,
    loudnessSummary,
    cpuMeasurementAvailability,
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
  splitStatsConfig,
  splitStatsPolicy,
}) {
  const {
    fallbackPlans,
    processingOrder,
    processingPlans,
  } = processingOrderContext;
  const {
    cpuLoudnormKey,
    cpuLoudnormMeasurementStore,
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
    cpuLoudnormMeasurementStore,
    cpuLoudnormKey,
    knownCpuLoudnormValues,
    startCpuLoudnormTask,
    splitStatsConfig,
    splitStatsPolicy,
  });
}

module.exports = {
  createCpuLoudnormCoordinatorStage,
  createSplitStatsCoordinatorStage,
  createStatsProcessingOrderStage,
};
