"use strict";

const {
  prepareSerialMeasuredRoute,
} = require("./streamSerialMeasuredRoute");
const {
  runSerialApplyDispatch,
} = require("./streamSerialApplyDispatch");

async function runSerialApplyRoute({
  streamCtx,
  planState,
}) {
  const { commands, execution, output, plans, progress, stats } = streamCtx;
  const { completedWork, plan, planLabel, spans } = planState;
  const splitStatsForPlan = stats.canSplitStatsPlan(plan);
  const measurement = {
    cpuLoudnormValues: null,
    firstPassStatsCacheInput: null,
    splitStatsCacheInput: null,
  };
  if (execution.useGpuSourcePort) {
    const measuredRoute = await prepareSerialMeasuredRoute({
      args: execution.args,
      debugLogging: execution.debugLogging,
      plan,
      planLabel,
      completedWork,
      measureSpan: spans.measure,
      normalizeSpan: spans.normalize,
      durationSeconds: execution.durationSeconds,
      splitStatsForPlan,
      canFuseAnyCpuLoudnormWithSplitStats: stats.canFuseAnyCpuLoudnormWithSplitStats,
      startCpuLoudnormTask: stats.startCpuLoudnormTask,
      startSplitStatsTask: stats.startSplitStatsTask,
      getCpuLoudnormRecord: stats.getCpuLoudnormRecord,
      splitPrefetchNextStatsAtProgress: stats.splitPrefetchNextStatsAtProgress,
      splitPrefetchNextStatsDuringStats: stats.splitPrefetchNextStatsDuringStats,
      prefetchNextSplitStats: stats.prefetchNextSplitStats,
      prefetchNextCpuLoudnorm: stats.prefetchNextCpuLoudnorm,
      processingOrder: plans.processingOrder,
      processingSampleRateFor: commands.processingSampleRateFor,
      targetI: execution.targetI,
      maxGain: execution.maxGain,
      updateProgress: progress.updateProgress,
      copyOriginalPackage: output.copyOriginalPackage,
    });
    if (measuredRoute.outputResult) return measuredRoute;
    measurement.cpuLoudnormValues = measuredRoute.cpuLoudnormValues;
    measurement.firstPassStatsCacheInput = measuredRoute.firstPassStatsCacheInput;
    measurement.splitStatsCacheInput = measuredRoute.splitStatsCacheInput;
  }

  return await runSerialApplyDispatch({
    streamCtx,
    planState,
    splitStatsForPlan,
    measurement,
  });
}

module.exports = {
  runSerialApplyRoute,
};
