"use strict";

const {
  prepareSerialMeasuredRoute,
} = require("./streamSerialMeasuredRoute");
const {
  runSerialApplyDispatch,
} = require("./streamSerialApplyDispatch");

async function runSerialApplyRoute({
  args,
  debugLogging,
  useGpuSourcePort,
  useStreamingSourcePort,
  targetI,
  maxGain,
  durationSeconds,
  plan,
  planLabel,
  describePlan,
  completedWork,
  measureSpan,
  decodeSpan,
  normalizeSpan,
  encodeSpan,
  streamStartedAt,
  processingOrder,
  updateProgress,
  getCpuLoudnormRecord,
  prefetchNextCpuLoudnorm,
  canSplitStatsPlan,
  canFuseAnyCpuLoudnormWithSplitStats,
  startCpuLoudnormTask,
  startSplitStatsTask,
  prefetchNextSplitStats,
  splitPrefetchNextStatsDuringStats,
  splitPrefetchNextStatsAtProgress,
  processingSampleRateFor,
  buildStreamingDecodeCommand,
  buildStreamingEncodeCommand,
  buildRawApplyCommand,
  buildRawDecodeCommand,
  buildRawEncodeCommand,
  buildSourceCoreGainsCommand,
  buildStreamingGpuPlan,
  buildRawSourcePortGpuPlan,
  wrapRuntimeProfile,
  runShell,
  runChecked,
  cleanupFilesForPlan,
  copyOriginalPackage,
}) {
  const splitStatsForPlan = canSplitStatsPlan(plan);
  let splitStatsCacheInput = null;
  let firstPassStatsCacheInput = null;
  let cpuLoudnormValues = null;
  if (useGpuSourcePort) {
    const measuredRoute = await prepareSerialMeasuredRoute({
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
    });
    if (measuredRoute.outputResult) return measuredRoute;
    cpuLoudnormValues = measuredRoute.cpuLoudnormValues;
    firstPassStatsCacheInput = measuredRoute.firstPassStatsCacheInput;
    splitStatsCacheInput = measuredRoute.splitStatsCacheInput;
  }

  return await runSerialApplyDispatch({
    args,
    debugLogging,
    useGpuSourcePort,
    useStreamingSourcePort,
    targetI,
    maxGain,
    durationSeconds,
    plan,
    planLabel,
    describePlan,
    completedWork,
    measureSpan,
    decodeSpan,
    normalizeSpan,
    encodeSpan,
    streamStartedAt,
    splitStatsForPlan,
    firstPassStatsCacheInput,
    splitStatsCacheInput,
    cpuLoudnormValues,
    buildStreamingDecodeCommand,
    buildStreamingEncodeCommand,
    buildRawApplyCommand,
    buildRawDecodeCommand,
    buildRawEncodeCommand,
    buildStreamingGpuPlan,
    buildRawSourcePortGpuPlan,
    buildSourceCoreGainsCommand,
    wrapRuntimeProfile,
    runShell,
    runChecked,
    cleanupFilesForPlan,
    copyOriginalPackage,
    updateProgress,
  });
}

module.exports = {
  runSerialApplyRoute,
};
