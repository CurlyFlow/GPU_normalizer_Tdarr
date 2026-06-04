"use strict";

const {
  measureStreamPlanLoudnorm,
} = require("./streamPlanCpuMeasure");
const {
  resolveMeasuredSplitStats,
  startMeasuredSplitStatsPrepass,
} = require("./streamPlanSplitStats");

async function prepareMeasuredSourcePortPlan({
  args,
  debugLogging,
  plan,
  planLabel,
  completedWork,
  measureSpan,
  normalizeSpan,
  durationSeconds,
  splitStatsForPlan,
  canFuseAnyCpuLoudnormWithSplitStats,
  startCpuLoudnormTask,
  startSplitStatsTask,
  getCpuLoudnormRecord,
  splitPrefetchNextStatsAtProgress,
  splitPrefetchNextStatsDuringStats,
  prefetchNextSplitStats,
  prefetchNextCpuLoudnorm,
  processingOrder,
  processingSampleRateFor,
  targetI,
  maxGain,
  updateProgress,
}) {
  let splitStatsCacheInput = null;
  const splitStatsTask = startMeasuredSplitStatsPrepass({
    plan,
    planLabel,
    completedWork,
    measureSpan,
    normalizeSpan,
    splitStatsForPlan,
    canFuseAnyCpuLoudnormWithSplitStats,
    startCpuLoudnormTask,
    startSplitStatsTask,
    splitPrefetchNextStatsAtProgress,
    splitPrefetchNextStatsDuringStats,
    prefetchNextSplitStats,
    updateProgress,
  });
  const measured = await measureStreamPlanLoudnorm({
    args,
    debugLogging,
    plan,
    planLabel,
    completedWork,
    measureSpan,
    durationSeconds,
    splitStatsTask,
    getCpuLoudnormRecord,
    targetI,
    maxGain,
    updateProgress,
  });
  const cpuLoudnormValues = measured.cpuLoudnormValues;
  const firstPassStatsCacheInput = measured.firstPassStatsCacheInput;
  if (measured.copyOriginalReason) {
    return {
      copyOriginalReason: measured.copyOriginalReason,
      cpuLoudnormValues,
      firstPassStatsCacheInput,
      splitStatsCacheInput,
    };
  }
  ({ splitStatsCacheInput } = await resolveMeasuredSplitStats({
    args,
    plan,
    planLabel,
    completedWork,
    measureSpan,
    normalizeSpan,
    splitStatsForPlan,
    splitStatsTask,
    cpuLoudnormValues,
    processingOrder,
    processingSampleRateFor,
    startSplitStatsTask,
    prefetchNextSplitStats,
    prefetchNextCpuLoudnorm,
    updateProgress,
  }));
  return {
    copyOriginalReason: "",
    cpuLoudnormValues,
    firstPassStatsCacheInput,
    splitStatsCacheInput,
  };
}

module.exports = {
  prepareMeasuredSourcePortPlan,
};
