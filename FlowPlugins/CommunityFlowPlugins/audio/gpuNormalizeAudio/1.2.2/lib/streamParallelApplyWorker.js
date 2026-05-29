"use strict";

const {
  gpuProgressFraction,
  logProfileStage,
} = require("./common");
const {
  finishCompletedStream,
} = require("./streamCompletionTelemetry");

async function runParallelApplyPlan({
  args,
  debugLogging,
  plan,
  measured,
  planLabel,
  describePlan,
  buildStreamingDecodeCommand,
  buildStreamingEncodeCommand,
  buildStreamingGpuPlan,
  wrapRuntimeProfile,
  runShell,
  runChecked,
  cleanupFilesForPlan,
  reportPlanProgress,
}) {
  const cpuLoudnormValues = measured.cpuLoudnormValues;
  const measureSpan = plan.work * 0.18;
  const decodeSpan = plan.work * 0.08;
  const normalizeSpan = plan.work * 0.54;
  const encodeSpan = plan.work * 0.2;
  const decodeCommand = buildStreamingDecodeCommand(plan, cpuLoudnormValues);
  const encodeCommand = buildStreamingEncodeCommand(plan, cpuLoudnormValues);
  const gpuPlan = buildStreamingGpuPlan(plan, cpuLoudnormValues, decodeCommand, encodeCommand, "");
  const gpuRes = await runShell(wrapRuntimeProfile(gpuPlan, plan, "streaming"), {
    args,
    label: `GPU streaming normalize ${planLabel}`,
    allowedCodes: [0, 42],
    capturePath: plan.sourceErr,
    logOnSuccess: debugLogging,
    parseLine: (line) => {
      const fraction = gpuProgressFraction(line);
      if (fraction !== null) reportPlanProgress(plan, measureSpan + decodeSpan + normalizeSpan * fraction);
    },
  });
  logProfileStage(args, { scope: "plugin", name: "gpu_source_port_streaming", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: gpuRes.wallSec });
  if (gpuRes.code === 42) {
    return { copyOriginalReason: `GPU normalize gain gate exceeded on ${planLabel}; copying original package` };
  }
  if (gpuRes.code !== 0) throw new Error(`GPU streaming normalize failed on ${planLabel}`);
  reportPlanProgress(plan, measureSpan + decodeSpan + normalizeSpan + encodeSpan, true);
  await finishCompletedStream({
    args,
    plan,
    planLabel,
    describePlan,
    streamStartedAt: measured.streamStartedAt,
    cleanupFiles: cleanupFilesForPlan(plan).filter((file) => file !== plan.normalizedAudio),
    runChecked,
  });
  reportPlanProgress(plan, plan.work, true);
  return { copyOriginalReason: "" };
}

module.exports = {
  runParallelApplyPlan,
};
