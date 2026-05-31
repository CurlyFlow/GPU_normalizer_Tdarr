"use strict";

const {
  runRawFilePlan,
} = require("./rawFileProcessor");
const {
  runStreamingSourcePortPlan,
} = require("./streamingSourcePortProcessor");

async function runSerialApplyDispatch({
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
  buildSourceCoreGainsCommand,
  buildStreamingGpuPlan,
  buildRawSourcePortGpuPlan,
  wrapRuntimeProfile,
  runShell,
  runChecked,
  cleanupFilesForPlan,
  copyOriginalPackage,
  updateProgress,
}) {
  if (useStreamingSourcePort) {
    const streamingResult = await runStreamingSourcePortPlan({
      args,
      debugLogging,
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
      buildStreamingGpuPlan,
      wrapRuntimeProfile,
      runShell,
      runChecked,
      cleanupFilesForPlan,
      copyOriginalPackage,
      updateProgress,
    });
    if (streamingResult.outputResult) return streamingResult;
    const nextCompletedWork = completedWork + plan.work;
    updateProgress(nextCompletedWork, true);
    return { completedWork: nextCompletedWork };
  }

  const rawResult = await runRawFilePlan({
    args,
    debugLogging,
    plan,
    planLabel,
    describePlan,
    completedWork,
    measureSpan,
    decodeSpan,
    normalizeSpan,
    encodeSpan,
    streamStartedAt,
    durationSeconds,
    cpuLoudnormValues,
    useGpuSourcePort,
    targetI,
    maxGain,
    buildRawApplyCommand,
    buildRawDecodeCommand,
    buildRawEncodeCommand,
    buildRawSourcePortGpuPlan,
    buildSourceCoreGainsCommand,
    wrapRuntimeProfile,
    runShell,
    runChecked,
    copyOriginalPackage,
    updateProgress,
  });
  if (rawResult.outputResult) return rawResult;
  const nextCompletedWork = completedWork + plan.work;
  updateProgress(nextCompletedWork, true);
  return { completedWork: nextCompletedWork };
}

module.exports = {
  runSerialApplyDispatch,
};
