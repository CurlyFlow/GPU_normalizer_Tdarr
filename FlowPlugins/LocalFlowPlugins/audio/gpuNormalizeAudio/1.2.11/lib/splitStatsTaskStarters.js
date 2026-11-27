"use strict";

const {
  createPairedSplitStatsTaskStarter,
} = require("./splitStatsPairedTask");
const {
  createSingleSplitStatsTaskStarter,
} = require("./splitStatsSingleTask");
const {
  resolveSplitStatsTaskMode,
} = require("./splitStatsStrategy");

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

  return (plan, reason, parseLine = () => {}, cpuLoudnormValuesForStats = null) => {
    const statsSampleRate = processingSampleRateFor(plan, cpuLoudnormValuesForStats);
    const key = splitStatsKey(plan, statsSampleRate);
    const { statsCache, statsErr } = trackStatsPaths(plan, statsSampleRate);
    const existingResult = splitStatsResults.get(key);
    if (existingResult) {
      return { promise: Promise.resolve(existingResult), statsSampleRate, statsCache };
    }
    const existingTask = splitStatsTasks.get(key);
    if (existingTask) return existingTask;
    const planLabel = planLabelFor(plan);
    const taskMode = resolveSplitStatsTaskMode({
      plan,
      cpuLoudnormKey,
      cpuLoudnormMeasurementStore,
      canFuseAnyCpuLoudnormWithSplitStats,
      canFuseOriginalCpuLoudnormWithSplitStats,
      pairedSplitStatsPartner,
      pairStereoFallbackSplitStatsFuseMeasure,
    });
    const { fuseCpuMeasure, fusePairedCpuMeasure, measureKey, measureMode, partner } = taskMode;
    if (partner) {
      const pairedTaskRecord = startPairedSplitStatsTask(plan, partner, statsSampleRate, statsCache, statsErr, key, reason, parseLine, { fuseCpuMeasure: fusePairedCpuMeasure });
      if (pairedTaskRecord) return pairedTaskRecord;
    }
    return startSingleSplitStatsTask({
      plan,
      statsSampleRate,
      statsCache,
      statsErr,
      key,
      planLabel,
      reason,
      parseLine,
      fuseCpuMeasure,
      measureMode,
      measureKey,
    });
  };
}

module.exports = {
  createSplitStatsTaskStarters,
};
