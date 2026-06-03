"use strict";

const {
  prepareMeasuredSourcePortPlan,
} = require("./streamPlanPreparation");

async function prepareSerialMeasuredRoute({
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
  copyOriginalPackage,
}) {
  const measuredPlan = await prepareMeasuredSourcePortPlan({
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
  });
  if (measuredPlan.copyOriginalReason) {
    return {
      outputResult: await copyOriginalPackage(
        measuredPlan.copyOriginalReason,
        completedWork + measureSpan,
      ),
    };
  }
  return {
    cpuLoudnormValues: measuredPlan.cpuLoudnormValues,
    firstPassStatsCacheInput: measuredPlan.firstPassStatsCacheInput,
    splitStatsCacheInput: measuredPlan.splitStatsCacheInput,
  };
}

module.exports = {
  prepareSerialMeasuredRoute,
};
