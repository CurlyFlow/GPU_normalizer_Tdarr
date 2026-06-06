"use strict";

const {
  runSerialApplyRoute,
} = require("./streamSerialApplyRouter");
const {
  runSerialPairedApplyRoute,
} = require("./streamSerialPairedApplyRoute");
const {
  createStreamPlanState,
} = require("./streamPlanState");

async function runSerialStreamPlan({
  streamCtx,
  plan,
  completedWork,
}) {
  const { execution, output, pairedApply, plans, progress } = streamCtx;
  const { pairedApplyCompleted, pairedFallbackApplyPartner, runPairedFallbackApply } = pairedApply;
  const planState = createStreamPlanState(streamCtx, plan, completedWork);
  const { spans } = planState;
  if (pairedApplyCompleted.has(plan.idx)) return { completedWork };
  execution.args.jobLog(`GPU Normalize Audio step: ${plans.describePlan(plan)}.`);

  const pairedApplyResult = await runSerialPairedApplyRoute({
    plan,
    completedWork,
    measureSpan: spans.measure,
    decodeSpan: spans.decode,
    normalizeSpan: spans.normalize,
    pairedApplyCompleted,
    pairedFallbackApplyPartner,
    runPairedFallbackApply,
    copyOriginalPackage: output.copyOriginalPackage,
    updateProgress: progress.updateProgress,
  });
  if (pairedApplyResult) return pairedApplyResult;

  return await runSerialApplyRoute({
    streamCtx,
    planState,
  });
}

module.exports = {
  runSerialStreamPlan,
};
