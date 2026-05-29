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
    cpuLoudnormResults,
    cpuLoudnormTasks,
    splitStatsResults,
    splitStatsTasks,
  });

  return createSplitStatsTaskDispatcher({
    processingSampleRateFor,
    trackStatsPaths,
    planLabelFor,
    cpuLoudnormResults,
    cpuLoudnormTasks,
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
