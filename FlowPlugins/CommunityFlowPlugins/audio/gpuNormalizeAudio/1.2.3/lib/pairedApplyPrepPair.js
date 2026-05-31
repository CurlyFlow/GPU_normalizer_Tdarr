"use strict";

const {
  preparePairedApplyPlan,
} = require("./pairedApplyPreparation");

async function preparePairedApplyPair({
  args,
  debugLogging,
  fallbackPlan,
  originalPlan,
  progressBase,
  durationSeconds,
  canSplitStatsPlan,
  canFuseAnyCpuLoudnormWithSplitStats,
  startCpuLoudnormTask,
  startSplitStatsTask,
  getCpuLoudnormRecord,
  processingSampleRateFor,
  planLabelFor,
  targetI,
  maxGain,
  updateProgress,
}) {
  const fallbackMeasureSpan = fallbackPlan.work * 0.18;
  const originalMeasureSpan = originalPlan.work * 0.18;
  const fallbackNormalizeSpan = fallbackPlan.work * 0.54;
  const originalNormalizeSpan = originalPlan.work * 0.54;
  const [fallbackPrep, originalPrep] = await Promise.all([
    preparePairedApplyPlan({
      args,
      debugLogging,
      plan: fallbackPlan,
      measureSpan: fallbackMeasureSpan,
      normalizeSpan: fallbackNormalizeSpan,
      progressBase,
      durationSeconds,
      canSplitStatsPlan,
      canFuseAnyCpuLoudnormWithSplitStats,
      startCpuLoudnormTask,
      startSplitStatsTask,
      getCpuLoudnormRecord,
      processingSampleRateFor,
      planLabelFor,
      targetI,
      maxGain,
      updateProgress,
    }),
    preparePairedApplyPlan({
      args,
      debugLogging,
      plan: originalPlan,
      measureSpan: originalMeasureSpan,
      normalizeSpan: originalNormalizeSpan,
      progressBase,
      durationSeconds,
      canSplitStatsPlan,
      canFuseAnyCpuLoudnormWithSplitStats,
      startCpuLoudnormTask,
      startSplitStatsTask,
      getCpuLoudnormRecord,
      processingSampleRateFor,
      planLabelFor,
      targetI,
      maxGain,
      updateProgress,
    }),
  ]);
  return {
    fallbackPrep,
    gate: [fallbackPrep, originalPrep].find((item) => item && item.copyOriginalReason),
    originalPrep,
  };
}

module.exports = {
  preparePairedApplyPair,
};
