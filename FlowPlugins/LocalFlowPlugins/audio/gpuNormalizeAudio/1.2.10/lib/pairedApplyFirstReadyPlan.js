"use strict";

const {
  gpuProgressFraction,
  logProfileStage,
  niceCommand,
} = require("./common");

async function runFirstReadyApplyPlan({
  args,
  debugLogging,
  plan,
  prep,
  niceLevel = 0,
  progressBase,
  buildStreamingDecodeCommand,
  buildStreamingEncodeCommand,
  buildStreamingGpuPlan,
  persistentStatsToApply = false,
  wrapRuntimeProfile,
  runShell,
  updateProgress,
}) {
  const decodeCommand = buildStreamingDecodeCommand(plan, prep.cpuLoudnormValues);
  const encodeCommand = buildStreamingEncodeCommand(plan, prep.cpuLoudnormValues);
  const statsCacheInput = persistentStatsToApply ? "" : (prep.splitStatsCacheInput || plan.statsCache);
  const gpuPlan = niceCommand(buildStreamingGpuPlan(plan, prep.cpuLoudnormValues, decodeCommand, encodeCommand, statsCacheInput), niceLevel);
  const measureSpan = plan.work * 0.18;
  const normalizeSpan = plan.work * 0.54;
  const encodeSpan = plan.work * 0.2;
  const profileLabel = persistentStatsToApply ? "paired-apply-persistent" : "paired-apply-first-ready";
  const res = await runShell(wrapRuntimeProfile(gpuPlan, plan, profileLabel), {
    args,
    label: persistentStatsToApply ? `GPU persistent paired apply stream ${plan.idx}` : `GPU first-ready paired apply stream ${plan.idx}`,
    allowedCodes: [0, 42],
    capturePath: plan.sourceErr,
    logOnSuccess: debugLogging,
    parseLine: (line) => {
      const fraction = gpuProgressFraction(line);
      if (fraction !== null) updateProgress(progressBase + measureSpan + normalizeSpan * fraction);
    },
  });
  logProfileStage(args, { scope: "plugin", name: persistentStatsToApply ? "gpu_source_port_streaming_paired_apply_persistent" : "gpu_source_port_streaming_paired_apply_first_ready", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: res.wallSec });
  if (res.code === 42) throw new Error(`GPU gain gate disagrees with the measured per-stream decision on stream ${plan.idx}`);
  if (res.code !== 0) throw new Error(`GPU first-ready paired apply failed on stream ${plan.idx}`);
  updateProgress(progressBase + measureSpan + normalizeSpan + encodeSpan, true);
  return { completed: true };
}

module.exports = {
  runFirstReadyApplyPlan,
};
