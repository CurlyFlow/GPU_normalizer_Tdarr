"use strict";

const {
  runSerialApplyRoute,
} = require("./streamSerialApplyRouter");
const {
  runSerialPairedApplyRoute,
} = require("./streamSerialPairedApplyRoute");

async function runSerialStreamPlan({
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
}) {
  if (pairedApplyCompleted.has(plan.idx)) return { completedWork };
  const streamStartedAt = Date.now();
  const planLabel = planLabelFor(plan);
  args.jobLog(`GPU Normalize Audio step: ${describePlan(plan)}.`);
  const measureSpan = useGpuSourcePort ? plan.work * 0.18 : 0;
  const decodeSpan = plan.work * 0.08;
  const normalizeSpan = plan.work * (useGpuSourcePort ? 0.54 : 0.72);
  const encodeSpan = plan.work * 0.2;

  const pairedApplyResult = await runSerialPairedApplyRoute({
    plan,
    completedWork,
    measureSpan,
    decodeSpan,
    normalizeSpan,
    pairedApplyCompleted,
    pairedFallbackApplyPartner,
    runPairedFallbackApply,
    copyOriginalPackage,
    updateProgress,
  });
  if (pairedApplyResult) return pairedApplyResult;

  return await runSerialApplyRoute({
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
  });
}

module.exports = {
  runSerialStreamPlan,
};
