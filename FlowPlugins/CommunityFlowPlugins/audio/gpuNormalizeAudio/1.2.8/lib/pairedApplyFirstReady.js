"use strict";

const {
  gpuProgressFraction,
  logProfileStage,
} = require("./common");

function applyNice(command, niceLevel) {
  return niceLevel > 0 ? `nice -n ${niceLevel} ${command}` : command;
}

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
  const gpuPlan = applyNice(buildStreamingGpuPlan(plan, prep.cpuLoudnormValues, decodeCommand, encodeCommand, statsCacheInput), niceLevel);
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
  originalNice = 0,
  progressBase,
  stereoNice = 0,
  buildStreamingDecodeCommand,
  buildStreamingEncodeCommand,
  buildStreamingGpuPlan,
  persistentStatsToApply = false,
  wrapRuntimeProfile,
  runShell,
  updateProgress,
}) {
  if (persistentStatsToApply) {
    args.jobLog("GPU normalize paired apply persistent-runtime scout enabled; waiting for both gain gates before per-stream stats+apply.");
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
        niceLevel: ready.plan.stereoFallback ? stereoNice : originalNice,
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

  args.jobLog("GPU normalize paired apply first-ready scout enabled; starting each final-mux apply as soon as its gain gate is ready.");
  const startWhenReady = (plan, prepPromise) => prepPromise.then((prep) => {
    if (prep.copyOriginalReason) return { copyOriginalReason: prep.copyOriginalReason };
    return runFirstReadyApplyPlan({
      args,
      debugLogging,
      plan,
      prep,
      niceLevel: plan.stereoFallback ? stereoNice : originalNice,
      progressBase,
      buildStreamingDecodeCommand,
      buildStreamingEncodeCommand,
      buildStreamingGpuPlan,
      persistentStatsToApply: false,
      wrapRuntimeProfile,
      runShell,
      updateProgress,
    });
  });
  const applyPromises = [
    startWhenReady(fallbackPlan, fallbackPrepPromise),
    startWhenReady(originalPlan, originalPrepPromise),
  ];
  for (const applyPromise of applyPromises) applyPromise.catch(() => {});
  const applyResults = await Promise.all(applyPromises);
  return {
    copyOriginalReason: (applyResults.find((res) => res.copyOriginalReason) || {}).copyOriginalReason || "",
  };
}

module.exports = {
  runFirstReadyPairedApply,
};
