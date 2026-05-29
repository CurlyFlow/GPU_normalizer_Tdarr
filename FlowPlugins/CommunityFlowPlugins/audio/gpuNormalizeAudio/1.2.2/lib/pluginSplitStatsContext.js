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
  cpuLoudnormResults,
  cpuLoudnormTasks,
  cpuLoudnormKey,
  knownCpuLoudnormValues,
  startCpuLoudnormTask,
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
    cpuLoudnormResults,
    cpuLoudnormTasks,
    cpuLoudnormKey,
    knownCpuLoudnormValues,
    startCpuLoudnormTask,
  });
}

module.exports = {
  createPluginSplitStatsContext,
};
