"use strict";

const {
  createSplitStatsCoordinator,
} = require("./splitStatsCoordinator");

function createPluginSplitStatsContext({
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
}) {
  return createSplitStatsCoordinator({
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
  createPluginSplitStatsContext,
};
