"use strict";

const {
  runFirstReadyApplyPlan,
} = require("./pairedApplyFirstReadyPlan");

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
  skipNormalization,
  updateProgress,
}) {
  if (persistentStatsToApply) {
    args.jobLog("GPU normalize paired apply persistent-runtime scout enabled; waiting for both gain gates before per-stream stats+apply.");
    const readyPlans = await Promise.all([
      fallbackPrepPromise.then((prep) => ({ plan: fallbackPlan, prep })),
      originalPrepPromise.then((prep) => ({ plan: originalPlan, prep })),
    ]);
    const applyPromises = readyPlans.map((ready) => ready.prep.skipReason
      ? skipNormalization(ready.plan, ready.prep.skipReason) : runFirstReadyApplyPlan({
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
    await Promise.all(applyPromises);
    return { completed: true };
  }

  args.jobLog("GPU normalize paired apply first-ready scout enabled; starting each final-mux apply as soon as its gain gate is ready.");
  const startWhenReady = (plan, prepPromise) => prepPromise.then((prep) => {
    if (prep.skipReason) return skipNormalization(plan, prep.skipReason);
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
  await Promise.all(applyPromises);
  return { completed: true };
}

module.exports = {
  runFirstReadyPairedApply,
};
