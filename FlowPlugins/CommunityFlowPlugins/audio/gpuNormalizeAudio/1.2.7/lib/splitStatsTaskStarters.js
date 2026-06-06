"use strict";

const {
  createPairedSplitStatsTaskStarter,
} = require("./splitStatsPairedTask");
const {
  createSingleSplitStatsTaskStarter,
} = require("./splitStatsSingleTask");
const {
  createSplitStatsTaskDispatcher,
} = require("./splitStatsTaskDispatcher");

function createSplitStatsTaskStarters({
  args,
  debugLogging,
  usesStereoFallbackSourcePath,
  processingSampleRateFor,
  trackStatsPaths,
  buildStatsRuntimePlan,
  loudnormFilter,
  decodeAudioArgs,
  runShell,
  wrapRuntimeProfile,
  planLabelFor,
  knownCpuLoudnormValues,
  cpuLoudnormMeasurementStore,
  cpuLoudnormKey,
  splitStatsKey,
  splitStatsResults,
  splitStatsTasks,
  splitStatsConfig,
  canFuseAnyCpuLoudnormWithSplitStats,
  canFuseOriginalCpuLoudnormWithSplitStats,
  pairedSplitStatsPartner,
  pairStereoFallbackSplitStatsFuseMeasure,
}) {
  const startPairedSplitStatsTask = createPairedSplitStatsTaskStarter({
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
  });

  const startSingleSplitStatsTask = createSingleSplitStatsTaskStarter({
    args,
    debugLogging,
    buildStatsRuntimePlan,
    loudnormFilter,
    decodeAudioArgs,
    runShell,
    wrapRuntimeProfile,
    canFuseOriginalCpuLoudnormWithSplitStats,
    cpuLoudnormMeasurementStore,
    splitStatsResults,
    splitStatsTasks,
  });

  return createSplitStatsTaskDispatcher({
    processingSampleRateFor,
    trackStatsPaths,
    planLabelFor,
    cpuLoudnormMeasurementStore,
    cpuLoudnormKey,
    splitStatsResults,
    splitStatsTasks,
    splitStatsKey,
    canFuseAnyCpuLoudnormWithSplitStats,
    canFuseOriginalCpuLoudnormWithSplitStats,
    pairedSplitStatsPartner,
    pairStereoFallbackSplitStatsFuseMeasure,
    startPairedSplitStatsTask,
    startSingleSplitStatsTask,
  });
}

module.exports = {
  createSplitStatsTaskStarters,
};
