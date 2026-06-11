"use strict";

const {
  preparePairedApplyPlan,
} = require("./pairedApplyPreparation");

function createPairedApplyPrepTasks({
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
  skipSplitStats = false,
  updateProgress,
}) {
  const fallbackMeasureSpan = fallbackPlan.work * 0.18;
  const originalMeasureSpan = originalPlan.work * 0.18;
  const fallbackNormalizeSpan = fallbackPlan.work * 0.54;
  const originalNormalizeSpan = originalPlan.work * 0.54;
  return {
    fallbackPrepPromise: preparePairedApplyPlan({
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
      skipSplitStats,
      updateProgress,
    }),
    originalPrepPromise: preparePairedApplyPlan({
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
      skipSplitStats,
      updateProgress,
    }),
  };
}

async function preparePairedApplyPair(opts) {
  const { fallbackPrepPromise, originalPrepPromise } = createPairedApplyPrepTasks(opts);
  const [fallbackPrep, originalPrep] = await Promise.all([fallbackPrepPromise, originalPrepPromise]);
  return {
    fallbackPrep,
    gate: [fallbackPrep, originalPrep].find((item) => item && item.copyOriginalReason),
    originalPrep,
  };
}

module.exports = {
  createPairedApplyPrepTasks,
  preparePairedApplyPair,
};
