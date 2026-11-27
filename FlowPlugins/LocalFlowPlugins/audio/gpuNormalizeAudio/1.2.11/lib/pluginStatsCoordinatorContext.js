"use strict";

const {
  envFlag,
  intNum,
} = require("./common");
const {
  createPluginCpuLoudnormContext,
} = require("./pluginCpuLoudnormContext");
const {
  createSplitStatsCoordinator,
} = require("./splitStatsCoordinator");
const {
  createSplitStatsConfig,
} = require("./splitStatsConfig");
const {
  createSplitStatsPolicy,
} = require("./splitStatsPolicy");

function createProcessingOrder({
  audioPlans,
  useGpuSourcePort,
  gpuFirstPassMeasure,
}) {
  const fallbackPlans = audioPlans.filter((plan) => plan.stereoFallback);
  const fallbackFirst = envFlag("LOUDNORM_GPU_FALLBACK_FIRST", true);
  const earlyPrefetchWithGpuFirstPass = gpuFirstPassMeasure
    && envFlag("LOUDNORM_GPU_CPU_LOUDNORM_EARLY_PREFETCH_WITH_GPU_FIRST_PASS");
  const earlyCpuPrefetch = (!gpuFirstPassMeasure || earlyPrefetchWithGpuFirstPass)
    && envFlag("LOUDNORM_GPU_CPU_LOUDNORM_EARLY_PREFETCH", true);
  const earlyCpuPrefetchLimit = Math.max(1, intNum(process.env.LOUDNORM_GPU_CPU_LOUDNORM_EARLY_PREFETCH_LIMIT, 1));
  const processingPlans = useGpuSourcePort && fallbackFirst && fallbackPlans.length > 0
    ? [...fallbackPlans, ...audioPlans.filter((plan) => !plan.stereoFallback)]
    : audioPlans;
  const processingOrder = new Map(processingPlans.map((plan, idx) => [plan.idx, idx]));

  return {
    earlyCpuPrefetch,
    earlyCpuPrefetchLimit,
    fallbackPlans,
    processingOrder,
    processingPlans,
  };
}

function createCpuLoudnormStatsCoordinator({
  core,
  planSetup,
  preflight,
  runtimeConfig,
  runtimeContext,
  processingPlans,
  cpuMeasurementAvailability,
}) {
  const { runtimePathConfig } = runtimeConfig;
  return createPluginCpuLoudnormContext({
    args: core.args,
    debugLogging: preflight.debugLogging,
    useGpuSourcePort: runtimePathConfig.useGpuSourcePort,
    gpuFirstPassMeasure: runtimeContext.gpuFirstPassMeasure,
    gpuFirstPassOriginalOnly: runtimeContext.gpuFirstPassOriginalOnly,
    gpuFirstPassAudit: runtimeContext.gpuFirstPassAudit,
    pairCpuLoudnormMeasure: runtimeContext.pairCpuLoudnormMeasure,
    audioPlans: planSetup.audioPlans,
    needsInlineStereoDownmix: planSetup.needsInlineStereoDownmix,
    runChecked: runtimeContext.runChecked,
    wrapRuntimeProfile: runtimeContext.wrapRuntimeProfile,
    buildGpuFirstPassInputMeasure: runtimeContext.buildGpuFirstPassInputMeasure,
    buildGpuFirstPassMeasure: runtimeContext.buildGpuFirstPassMeasure,
    buildCpuLoudnormMeasure: runtimeContext.buildCpuLoudnormMeasure,
    buildPairedCpuLoudnormMeasure: runtimeContext.buildPairedCpuLoudnormMeasure,
    processingSampleRateFor: runtimeContext.processingSampleRateFor,
    statsCachePathFor: planSetup.statsCachePathFor,
    trackStatsCachePath: planSetup.trackStatsCachePath,
    sourceChannelsFor: planSetup.sourceChannelsFor,
    planLabelFor: planSetup.planLabelFor,
    loudnessSummary: runtimeContext.loudnessSummary,
    cpuMeasurementAvailability,
    processingPlans,
  });
}

function createSplitStatsStatsCoordinator({
  core,
  planSetup,
  preflight,
  runtimeConfig,
  runtimeContext,
  processingOrderContext,
  cpuLoudnormContext,
  splitStatsConfig,
  splitStatsPolicy,
}) {
  const { audioConfig, runtimePathConfig } = runtimeConfig;
  const {
    fallbackPlans,
    processingOrder,
    processingPlans,
  } = processingOrderContext;
  return createSplitStatsCoordinator({
    args: core.args,
    debugLogging: preflight.debugLogging,
    useGpuSourcePort: runtimePathConfig.useGpuSourcePort,
    useStreamingSourcePort: audioConfig.useStreamingSourcePort,
    gpuFirstPassMeasure: runtimeContext.gpuFirstPassMeasure,
    fallbackPlans,
    audioPlans: planSetup.audioPlans,
    processingPlans,
    processingOrder,
    needsInlineStereoDownmix: planSetup.needsInlineStereoDownmix,
    usesStereoFallbackSourcePath: planSetup.usesStereoFallbackSourcePath,
    processingSampleRateFor: runtimeContext.processingSampleRateFor,
    trackStatsPaths: planSetup.trackStatsPaths,
    buildStatsRuntimePlan: runtimeContext.buildStatsRuntimePlan,
    loudnormFilter: runtimeContext.loudnormFilter,
    decodeAudioArgs: runtimeContext.decodeAudioArgs,
    runShell: core.runShell,
    wrapRuntimeProfile: runtimeContext.wrapRuntimeProfile,
    planLabelFor: planSetup.planLabelFor,
    cpuLoudnormMeasurementStore: cpuLoudnormContext.cpuLoudnormMeasurementStore,
    cpuLoudnormKey: cpuLoudnormContext.cpuLoudnormKey,
    knownCpuLoudnormValues: cpuLoudnormContext.knownCpuLoudnormValues,
    startCpuLoudnormTask: cpuLoudnormContext.startCpuLoudnormTask,
    splitStatsConfig,
    splitStatsPolicy,
  });
}

function createPluginStatsCoordinatorContext(model, runtimeContext) {
  const { core, planSetup, preflight, runtimeConfig } = model;
  const { audioConfig, runtimePathConfig } = runtimeConfig;
  const processingOrderContext = createProcessingOrder({
    audioPlans: planSetup.audioPlans,
    useGpuSourcePort: runtimePathConfig.useGpuSourcePort,
    gpuFirstPassMeasure: runtimeContext.gpuFirstPassMeasure,
  });
  const splitStatsConfig = createSplitStatsConfig({
    args: core.args,
    fallbackPlans: processingOrderContext.fallbackPlans,
  });
  const splitStatsPolicy = createSplitStatsPolicy({
    splitStatsConfig,
    useGpuSourcePort: runtimePathConfig.useGpuSourcePort,
    useStreamingSourcePort: audioConfig.useStreamingSourcePort,
    gpuFirstPassMeasure: runtimeContext.gpuFirstPassMeasure,
    fallbackPlans: processingOrderContext.fallbackPlans,
    audioPlans: planSetup.audioPlans,
    processingPlans: processingOrderContext.processingPlans,
    processingOrder: processingOrderContext.processingOrder,
    needsInlineStereoDownmix: planSetup.needsInlineStereoDownmix,
    usesStereoFallbackSourcePath: planSetup.usesStereoFallbackSourcePath,
  });
  const cpuMeasurementAvailability = {
    shouldWaitForFusedProducer: splitStatsPolicy.canFuseAnyCpuLoudnormWithSplitStats,
  };
  const cpuLoudnormContext = createCpuLoudnormStatsCoordinator({
    core,
    planSetup,
    preflight,
    runtimeConfig,
    runtimeContext,
    processingPlans: processingOrderContext.processingPlans,
    cpuMeasurementAvailability,
  });
  const splitStatsCoordinator = createSplitStatsStatsCoordinator({
    core,
    planSetup,
    preflight,
    runtimeConfig,
    runtimeContext,
    processingOrderContext,
    cpuLoudnormContext,
    splitStatsConfig,
    splitStatsPolicy,
  });

  return {
    canFuseAnyCpuLoudnormWithSplitStats: splitStatsCoordinator.canFuseAnyCpuLoudnormWithSplitStats,
    canSplitStatsPlan: splitStatsCoordinator.canSplitStatsPlan,
    cancelBackgroundCpu: cpuLoudnormContext.cancelBackgroundCpu,
    earlyCpuPrefetch: processingOrderContext.earlyCpuPrefetch,
    earlyCpuPrefetchLimit: processingOrderContext.earlyCpuPrefetchLimit,
    getCpuLoudnormRecord: cpuLoudnormContext.getCpuLoudnormRecord,
    prefetchCpuLoudnormFrom: cpuLoudnormContext.prefetchCpuLoudnormFrom,
    prefetchNextCpuLoudnorm: cpuLoudnormContext.prefetchNextCpuLoudnorm,
    prefetchNextSplitStats: splitStatsCoordinator.prefetchNextSplitStats,
    processingOrder: processingOrderContext.processingOrder,
    processingPlans: processingOrderContext.processingPlans,
    settleCpuLoudnormTasks: cpuLoudnormContext.settleCpuLoudnormTasks,
    splitPrefetchNextStatsAtProgress: splitStatsCoordinator.splitPrefetchNextStatsAtProgress,
    splitPrefetchNextStatsDuringStats: splitStatsCoordinator.splitPrefetchNextStatsDuringStats,
    startCpuLoudnormTask: cpuLoudnormContext.startCpuLoudnormTask,
    startSplitStatsTask: splitStatsCoordinator.startSplitStatsTask,
  };
}

module.exports = {
  createPluginStatsCoordinatorContext,
};
