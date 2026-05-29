"use strict";

const {
  runSerialStreamPlan,
} = require("./streamSerialPlanRunner");

async function runSerialStreamProcessing({
  args,
  debugLogging,
  useGpuSourcePort,
  useStreamingSourcePort,
  targetI,
  maxGain,
  durationSeconds,
  processingPlans,
  processingOrder,
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
}) {
  let completedWork = 0;
  for (const plan of processingPlans) {
    const planResult = await runSerialStreamPlan({
      args,
      debugLogging,
      useGpuSourcePort,
      useStreamingSourcePort,
      targetI,
      maxGain,
      durationSeconds,
      plan,
      completedWork,
      processingOrder,
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
    if (planResult.outputResult) return planResult;
    completedWork = planResult.completedWork;
  }
  return { completedWork };
}

module.exports = {
  runSerialStreamProcessing,
};
