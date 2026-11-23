"use strict";

const {
  measurePairedApplyLoudnorm,
} = require("./pairedApplyMeasurement");
const {
  pairedSplitStatsEnabled,
  resolvePairedSplitStats,
  startPairedSplitStatsPrepass,
} = require("./pairedApplySplitStats");

async function preparePairedApplyPlan({
  args,
  debugLogging,
  plan,
  measureSpan,
  normalizeSpan,
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
  const planLabel = planLabelFor(plan);
  const splitStatsForPlan = pairedSplitStatsEnabled({ plan, skipSplitStats, canSplitStatsPlan });
  const splitStatsTask = startPairedSplitStatsPrepass({
    plan,
    measureSpan,
    normalizeSpan,
    progressBase,
    splitStatsForPlan,
    canFuseAnyCpuLoudnormWithSplitStats,
    startCpuLoudnormTask,
    startSplitStatsTask,
    updateProgress,
  });
  const measured = await measurePairedApplyLoudnorm({
    args,
    debugLogging,
    plan,
    planLabel,
    measureSpan,
    progressBase,
    durationSeconds,
    splitStatsTask,
    getCpuLoudnormRecord,
    targetI,
    maxGain,
    updateProgress,
  });
  const cpuLoudnormValues = measured.cpuLoudnormValues;
  if (measured.skipReason) {
    return { skipReason: measured.skipReason };
  }
  const { splitStatsCacheInput } = await resolvePairedSplitStats({
    args,
    plan,
    planLabel,
    measureSpan,
    normalizeSpan,
    progressBase,
    splitStatsForPlan,
    splitStatsTask,
    cpuLoudnormValues,
    processingSampleRateFor,
    startSplitStatsTask,
    updateProgress,
  });
  return { cpuLoudnormValues, splitStatsCacheInput };
}

module.exports = {
  preparePairedApplyPlan,
};
