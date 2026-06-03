"use strict";

const {
  gpuProgressFraction,
  logProfileStage,
} = require("./common");
const {
  finishCompletedStream,
} = require("./streamCompletionTelemetry");

async function runStreamingSourcePortPlan({
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
}) {
  const decodeCommand = buildStreamingDecodeCommand(plan, cpuLoudnormValues);
  const encodeCommand = buildStreamingEncodeCommand(plan, cpuLoudnormValues);
  const statsCacheInput = (splitStatsForPlan || firstPassStatsCacheInput)
    ? (splitStatsCacheInput || firstPassStatsCacheInput || plan.statsCache)
    : "";
  const gpuPlan = buildStreamingGpuPlan(plan, cpuLoudnormValues, decodeCommand, encodeCommand, statsCacheInput);
  const gpuRes = await runShell(wrapRuntimeProfile(gpuPlan, plan, "streaming"), {
    args,
    label: `GPU streaming normalize ${planLabel}`,
    allowedCodes: [0, 42],
    capturePath: plan.sourceErr,
    logOnSuccess: debugLogging,
    parseLine: (line) => {
      const fraction = gpuProgressFraction(line);
      if (fraction !== null) updateProgress(completedWork + measureSpan + decodeSpan + normalizeSpan * fraction);
    },
  });
  logProfileStage(args, { scope: "plugin", name: "gpu_source_port_streaming", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: gpuRes.wallSec });
  if (splitStatsForPlan || firstPassStatsCacheInput) logProfileStage(args, { scope: "plugin", name: "gpu_source_port_streaming_total", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: (Date.now() - streamStartedAt) / 1000 });
  if (gpuRes.code === 42) {
    return { outputResult: await copyOriginalPackage(`GPU normalize gain gate exceeded on ${planLabel}; copying original package`, completedWork + measureSpan + decodeSpan + normalizeSpan) };
  }
  if (gpuRes.code !== 0) throw new Error(`GPU streaming normalize failed on ${planLabel}`);
  updateProgress(completedWork + measureSpan + decodeSpan + normalizeSpan + encodeSpan, true);
  await finishCompletedStream({
    args,
    plan,
    planLabel,
    describePlan,
    streamStartedAt,
    cleanupFiles: cleanupFilesForPlan(plan).filter((file) => file !== plan.normalizedAudio),
    runChecked,
  });
  return { completed: true };
}

module.exports = {
  runStreamingSourcePortPlan,
};
