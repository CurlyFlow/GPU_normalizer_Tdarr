"use strict";

const {
  createCpuLoudnormCoordinatorStage,
  createSplitStatsCoordinatorStage,
  createStatsProcessingOrderStage,
} = require("./pluginStatsCoordinatorStages");

function createPluginStatsCoordinatorContext({
  args,
  debugLogging,
  useGpuSourcePort,
  useStreamingSourcePort,
  gpuFirstPassMeasure,
  gpuFirstPassAudit,
  pairCpuLoudnormMeasure,
  audioPlans,
  needsInlineStereoDownmix,
  usesStereoFallbackSourcePath,
  runChecked,
  wrapRuntimeProfile,
  buildGpuFirstPassMeasure,
  buildCpuLoudnormMeasure,
  buildPairedCpuLoudnormMeasure,
  processingSampleRateFor,
  statsCachePathFor,
  sourceChannelsFor,
  planLabelFor,
  loudnessSummary,
  trackStatsPaths,
  buildStatsRuntimePlan,
  loudnormFilter,
  decodeAudioArgs,
  runShell,
}) {
  let canFuseAnyCpuLoudnormWithSplitStats = () => false;
  const processingOrderContext = createStatsProcessingOrderStage({
    audioPlans,
    useGpuSourcePort,
    gpuFirstPassMeasure,
  });
  const {
    earlyCpuPrefetch,
    earlyCpuPrefetchLimit,
    processingOrder,
    processingPlans,
  } = processingOrderContext;

  const cpuLoudnormContext = createCpuLoudnormCoordinatorStage({
    args,
    debugLogging,
    useGpuSourcePort,
    gpuFirstPassMeasure,
    gpuFirstPassAudit,
    pairCpuLoudnormMeasure,
    audioPlans,
    needsInlineStereoDownmix,
    runChecked,
    wrapRuntimeProfile,
    buildGpuFirstPassMeasure,
    buildCpuLoudnormMeasure,
    buildPairedCpuLoudnormMeasure,
    processingSampleRateFor,
    statsCachePathFor,
    sourceChannelsFor,
    planLabelFor,
    loudnessSummary,
    canFuseAnyCpuLoudnormWithSplitStats: (plan) => canFuseAnyCpuLoudnormWithSplitStats(plan),
    processingPlans,
  });
  const {
    cancelBackgroundCpu,
    cpuLoudnormKey,
    cpuLoudnormResults,
    cpuLoudnormTasks,
    getCpuLoudnormRecord,
    knownCpuLoudnormValues,
    prefetchCpuLoudnormFrom,
    prefetchNextCpuLoudnorm,
    settleCpuLoudnormTasks,
    startCpuLoudnormTask,
  } = cpuLoudnormContext;

  const splitStatsCoordinator = createSplitStatsCoordinatorStage({
    args,
    debugLogging,
    useGpuSourcePort,
    useStreamingSourcePort,
    gpuFirstPassMeasure,
    audioPlans,
    processingOrderContext,
    needsInlineStereoDownmix,
    usesStereoFallbackSourcePath,
    processingSampleRateFor,
    trackStatsPaths,
    buildStatsRuntimePlan,
    loudnormFilter,
    decodeAudioArgs,
    runShell,
    wrapRuntimeProfile,
    planLabelFor,
    cpuLoudnormContext,
  });
  const {
    canSplitStatsPlan,
    prefetchNextSplitStats,
    splitPrefetchNextStatsDuringStats,
    splitPrefetchNextStatsAtProgress,
    startSplitStatsTask,
  } = splitStatsCoordinator;
  canFuseAnyCpuLoudnormWithSplitStats = splitStatsCoordinator.canFuseAnyCpuLoudnormWithSplitStats;

  return {
    canFuseAnyCpuLoudnormWithSplitStats,
    canSplitStatsPlan,
    cancelBackgroundCpu,
    earlyCpuPrefetch,
    earlyCpuPrefetchLimit,
    getCpuLoudnormRecord,
    prefetchCpuLoudnormFrom,
    prefetchNextCpuLoudnorm,
    prefetchNextSplitStats,
    processingOrder,
    processingPlans,
    settleCpuLoudnormTasks,
    splitPrefetchNextStatsAtProgress,
    splitPrefetchNextStatsDuringStats,
    startCpuLoudnormTask,
    startSplitStatsTask,
  };
}

module.exports = {
  createPluginStatsCoordinatorContext,
};
