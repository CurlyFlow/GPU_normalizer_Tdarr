"use strict";

const {
  selectStreamApplyBackend,
} = require("./streamApplyBackend");

function createStreamPipelineDeps({
  args,
  debugLogging,
  useGpuSourcePort,
  useStreamingSourcePort,
  gpuFirstPassMeasure,
  targetI,
  maxGain,
  durationSeconds,
  processingPlans,
  processingOrder,
  audioWork,
  earlyCpuPrefetch,
  earlyCpuPrefetchLimit,
  pairStereoFallbackApply,
  updateProgress,
  planLabelFor,
  describePlan,
  getCpuLoudnormRecord,
  prefetchCpuLoudnormFrom,
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
  pairedApplyCompleted,
  pairedFallbackApplyPartner,
  runPairedFallbackApply,
  copyOriginalPackage,
}) {
  return {
    commands: {
      buildRawApplyCommand,
      buildRawDecodeCommand,
      buildRawEncodeCommand,
      buildRawSourcePortGpuPlan,
      buildSourceCoreGainsCommand,
      buildStreamingDecodeCommand,
      buildStreamingEncodeCommand,
      buildStreamingGpuPlan,
      cleanupFilesForPlan,
      processingSampleRateFor,
      runChecked,
      runShell,
      wrapRuntimeProfile,
    },
    execution: {
      args,
      debugLogging,
      durationSeconds,
      gpuFirstPassMeasure,
      maxGain,
      targetI,
      useGpuSourcePort,
      useStreamingSourcePort,
    },
    output: {
      copyOriginalPackage,
    },
    pairedApply: {
      pairStereoFallbackApply,
      pairedApplyCompleted,
      pairedFallbackApplyPartner,
      runPairedFallbackApply,
    },
    plans: {
      audioWork,
      describePlan,
      planLabelFor,
      processingOrder,
      processingPlans,
    },
    prefetch: {
      earlyCpuPrefetch,
      earlyCpuPrefetchLimit,
      prefetchCpuLoudnormFrom,
    },
    progress: {
      updateProgress,
    },
    stats: {
      canFuseAnyCpuLoudnormWithSplitStats,
      canSplitStatsPlan,
      getCpuLoudnormRecord,
      prefetchNextCpuLoudnorm,
      prefetchNextSplitStats,
      splitPrefetchNextStatsAtProgress,
      splitPrefetchNextStatsDuringStats,
      startCpuLoudnormTask,
      startSplitStatsTask,
    },
  };
}

function createStreamExecutionContext(deps, policy) {
  const streamCtx = {
    commands: deps.commands,
    execution: deps.execution,
    output: deps.output,
    pairedApply: deps.pairedApply,
    plans: deps.plans,
    policy,
    prefetch: deps.prefetch,
    progress: deps.progress,
    stats: deps.stats,
  };
  streamCtx.backend = selectStreamApplyBackend(streamCtx);
  return streamCtx;
}

module.exports = {
  createStreamExecutionContext,
  createStreamPipelineDeps,
};
