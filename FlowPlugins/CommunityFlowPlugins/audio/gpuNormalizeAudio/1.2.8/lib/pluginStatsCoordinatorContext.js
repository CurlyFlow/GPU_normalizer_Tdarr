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

function createStatsCoordinatorInput(model, runtimeContext) {
  const { core, planSetup, preflight, runtimeConfig } = model;
  const { audioConfig, runtimePathConfig } = runtimeConfig;
  return {
    args: core.args,
    audioPlans: planSetup.audioPlans,
    buildCpuLoudnormMeasure: runtimeContext.buildCpuLoudnormMeasure,
    buildGpuFirstPassInputMeasure: runtimeContext.buildGpuFirstPassInputMeasure,
    buildGpuFirstPassMeasure: runtimeContext.buildGpuFirstPassMeasure,
    buildGpuFirstPassMixedSharedStats: runtimeContext.buildGpuFirstPassMixedSharedStats,
    buildGpuFirstPassMixedSharedDecode: runtimeContext.buildGpuFirstPassMixedSharedDecode,
    buildGpuFirstPassOutputApplyFromStats: runtimeContext.buildGpuFirstPassOutputApplyFromStats,
    buildPairedCpuLoudnormMeasure: runtimeContext.buildPairedCpuLoudnormMeasure,
    buildStatsRuntimePlan: runtimeContext.buildStatsRuntimePlan,
    debugLogging: preflight.debugLogging,
    decodeAudioArgs: runtimeContext.decodeAudioArgs,
    gpuFirstPassAudit: runtimeContext.gpuFirstPassAudit,
    gpuFirstPassMeasure: runtimeContext.gpuFirstPassMeasure,
    loudnessSummary: runtimeContext.loudnessSummary,
    loudnormFilter: runtimeContext.loudnormFilter,
    needsInlineStereoDownmix: planSetup.needsInlineStereoDownmix,
    pairCpuLoudnormMeasure: runtimeContext.pairCpuLoudnormMeasure,
    planLabelFor: planSetup.planLabelFor,
    processingSampleRateFor: runtimeContext.processingSampleRateFor,
    runChecked: runtimeContext.runChecked,
    runShell: core.runShell,
    sourceChannelsFor: planSetup.sourceChannelsFor,
    statsCachePathFor: planSetup.statsCachePathFor,
    trackStatsCachePath: planSetup.trackStatsCachePath,
    trackStatsPaths: planSetup.trackStatsPaths,
    useGpuSourcePort: runtimePathConfig.useGpuSourcePort,
    usesStereoFallbackSourcePath: planSetup.usesStereoFallbackSourcePath,
    useStreamingSourcePort: audioConfig.useStreamingSourcePort,
    wrapRuntimeProfile: runtimeContext.wrapRuntimeProfile,
  };
}

function createPluginStatsCoordinatorContext(model, runtimeContext) {
  const {
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
  buildGpuFirstPassInputMeasure,
  buildGpuFirstPassMixedSharedStats,
  buildGpuFirstPassMixedSharedDecode,
  buildGpuFirstPassOutputApplyFromStats,
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
  } = createStatsCoordinatorInput(model, runtimeContext);
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
    buildGpuFirstPassInputMeasure,
    buildGpuFirstPassMixedSharedStats,
    buildGpuFirstPassMixedSharedDecode,
    buildGpuFirstPassOutputApplyFromStats,
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
