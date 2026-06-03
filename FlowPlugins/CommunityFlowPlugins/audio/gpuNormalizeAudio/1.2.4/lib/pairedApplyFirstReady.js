"use strict";

const {
  gpuProgressFraction,
  logProfileStage,
} = require("./common");

async function runFirstReadyApplyPlan({
  args,
  debugLogging,
  plan,
  prep,
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
  const gpuPlan = buildStreamingGpuPlan(plan, prep.cpuLoudnormValues, decodeCommand, encodeCommand, statsCacheInput);
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
  if (res.code === 42) return { copyOriginalReason: `GPU normalize gain gate exceeded on stream ${plan.idx}; copying original package` };
  if (res.code !== 0) throw new Error(`GPU first-ready paired apply failed on stream ${plan.idx}`);
  updateProgress(progressBase + measureSpan + normalizeSpan + encodeSpan, true);
  return { copyOriginalReason: "" };
}

async function runFirstReadyPairedApply({
  args,
  debugLogging,
  fallbackPlan,
  originalPlan,
  fallbackPrepPromise,
  originalPrepPromise,
  progressBase,
  buildStreamingDecodeCommand,
  buildStreamingEncodeCommand,
  buildStreamingGpuPlan,
  persistentStatsToApply = false,
  wrapRuntimeProfile,
  runShell,
  updateProgress,
}) {
  args.jobLog(persistentStatsToApply
    ? "GPU normalize paired apply persistent-runtime scout enabled; waiting for both gain gates before per-stream stats+apply."
    : "GPU normalize paired apply first-ready scout enabled; waiting for both gain gates before final-mux apply.");
  const readyPlans = await Promise.all([
    fallbackPrepPromise.then((prep) => ({ plan: fallbackPlan, prep })),
    originalPrepPromise.then((prep) => ({ plan: originalPlan, prep })),
  ]);
  const gateReady = readyPlans.find((ready) => ready.prep.copyOriginalReason);
  const copyOriginalReason = gateReady ? gateReady.prep.copyOriginalReason : "";
  if (copyOriginalReason) return { copyOriginalReason };

  const applyPromises = readyPlans.map((ready) => runFirstReadyApplyPlan({
      args,
      debugLogging,
      plan: ready.plan,
      prep: ready.prep,
      progressBase,
      buildStreamingDecodeCommand,
      buildStreamingEncodeCommand,
      buildStreamingGpuPlan,
      persistentStatsToApply,
      wrapRuntimeProfile,
      runShell,
      updateProgress,
    }));
  for (const applyPromise of applyPromises) applyPromise.catch(() => {});
  const applyResults = await Promise.all(applyPromises);
  return {
    copyOriginalReason: (applyResults.find((res) => res.copyOriginalReason) || {}).copyOriginalReason || "",
  };
}

module.exports = {
  runFirstReadyPairedApply,
};
