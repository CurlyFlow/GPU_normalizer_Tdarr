"use strict";

const {
  createStreamProcessorPolicy,
  prefetchInitialCpuLoudnorm,
} = require("./streamProcessorPolicy");
const {
  runStreamProcessorRoute,
} = require("./streamProcessorRoutes");

function createStreamProcessor({
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
  const {
    streamParallelism,
    useStreamParallelism,
  } = createStreamProcessorPolicy({
    useGpuSourcePort,
    useStreamingSourcePort,
    gpuFirstPassMeasure,
    processingPlans,
  });

  const processStreams = async () => {
    prefetchInitialCpuLoudnorm({
      earlyCpuPrefetch,
      earlyCpuPrefetchLimit,
      pairStereoFallbackApply,
      prefetchCpuLoudnormFrom,
    });
    updateProgress(0, true);
    return await runStreamProcessorRoute({
      args,
      debugLogging,
      useGpuSourcePort,
      useStreamingSourcePort,
      targetI,
      maxGain,
      durationSeconds,
      processingPlans,
      processingOrder,
      audioWork,
      streamParallelism,
      useStreamParallelism,
      updateProgress,
      planLabelFor,
      describePlan,
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
      pairedApplyCompleted,
      pairedFallbackApplyPartner,
      runPairedFallbackApply,
      copyOriginalPackage,
    });
  };

  return {
    processStreams,
  };
}

module.exports = {
  createStreamProcessor,
};
