"use strict";

function createSplitStatsTaskDispatcher({
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
    const measureKey = cpuLoudnormKey(plan);
    const fuseCpuMeasure = canFuseAnyCpuLoudnormWithSplitStats(plan)
      && !cpuLoudnormResults.has(measureKey)
      && !cpuLoudnormTasks.has(measureKey);
    const pairedPartner = pairedSplitStatsPartner(plan);
    const partnerMeasureKey = pairedPartner ? cpuLoudnormKey(pairedPartner) : null;
    const fusePairedCpuMeasure = fuseCpuMeasure
      && pairStereoFallbackSplitStatsFuseMeasure
      && pairedPartner
      && canFuseOriginalCpuLoudnormWithSplitStats(pairedPartner)
      && !cpuLoudnormResults.has(partnerMeasureKey)
      && !cpuLoudnormTasks.has(partnerMeasureKey);
    const partner = fuseCpuMeasure && !fusePairedCpuMeasure ? null : pairedPartner;
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
      measureKey,
    });
  };
}

module.exports = {
  createSplitStatsTaskDispatcher,
};
