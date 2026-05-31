"use strict";

const {
  createCpuLoudnormCoordinatorStage,
  createSplitStatsCoordinatorStage,
  createStatsProcessingOrderStage,
} = require("./pluginStatsCoordinatorStages");
const {
  createSplitStatsConfig,
} = require("./splitStatsConfig");
const {
  createSplitStatsPolicy,
} = require("./splitStatsPolicy");

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
  trackStatsCachePath,
  trackStatsPaths,
  buildStatsRuntimePlan,
  loudnormFilter,
  decodeAudioArgs,
  runShell,
}) {
  const processingOrderContext = createStatsProcessingOrderStage({
    audioPlans,
    useGpuSourcePort,
    gpuFirstPassMeasure,
  });
  const {
    earlyCpuPrefetch,
    earlyCpuPrefetchLimit,
    fallbackPlans,
    processingOrder,
    processingPlans,
  } = processingOrderContext;

  const splitStatsConfig = createSplitStatsConfig({
    args,
    fallbackPlans,
  });
  const splitStatsPolicy = createSplitStatsPolicy({
    splitStatsConfig,
    useGpuSourcePort,
    useStreamingSourcePort,
    gpuFirstPassMeasure,
    fallbackPlans,
    audioPlans,
    processingPlans,
    processingOrder,
    needsInlineStereoDownmix,
    usesStereoFallbackSourcePath,
  });
  const cpuMeasurementAvailability = {
    shouldWaitForFusedProducer: splitStatsPolicy.canFuseAnyCpuLoudnormWithSplitStats,
  };

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
    trackStatsCachePath,
    sourceChannelsFor,
    planLabelFor,
    loudnessSummary,
    cpuMeasurementAvailability,
    processingPlans,
  });
  const {
    cancelBackgroundCpu,
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
    splitStatsConfig,
    splitStatsPolicy,
  });
  const {
    canSplitStatsPlan,
    prefetchNextSplitStats,
    splitPrefetchNextStatsDuringStats,
    splitPrefetchNextStatsAtProgress,
    startSplitStatsTask,
  } = splitStatsCoordinator;

  return {
    canFuseAnyCpuLoudnormWithSplitStats: splitStatsCoordinator.canFuseAnyCpuLoudnormWithSplitStats,
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
