"use strict";

const {
  resolveSplitStatsTaskMode,
} = require("./splitStatsStrategy");

function createSplitStatsTaskDispatcher({
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
}) {
  return (plan, reason, parseLine = () => {}, cpuLoudnormValuesForStats = null) => {
    const statsSampleRate = processingSampleRateFor(plan, cpuLoudnormValuesForStats);
    const key = splitStatsKey(plan, statsSampleRate);
    const { statsCache, statsErr } = trackStatsPaths(plan, statsSampleRate);
    const existingResult = splitStatsResults.get(key);
    if (existingResult) {
      const resolved = Promise.resolve(existingResult);
      resolved.statsSampleRate = statsSampleRate;
      resolved.statsCache = statsCache;
      return resolved;
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
      const pairedTask = startPairedSplitStatsTask(plan, partner, statsSampleRate, statsCache, statsErr, key, reason, parseLine, { fuseCpuMeasure: fusePairedCpuMeasure });
      if (pairedTask) return pairedTask;
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
  createSplitStatsTaskDispatcher,
};
