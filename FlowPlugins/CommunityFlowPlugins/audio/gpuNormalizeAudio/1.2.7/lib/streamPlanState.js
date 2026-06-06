"use strict";

function createStreamPlanState(streamCtx, plan, completedWork) {
  const { execution, plans } = streamCtx;
  return {
    completedWork,
    plan,
    planLabel: plans.planLabelFor(plan),
    spans: {
      decode: plan.work * 0.08,
      encode: plan.work * 0.2,
      measure: execution.useGpuSourcePort ? plan.work * 0.18 : 0,
      normalize: plan.work * (execution.useGpuSourcePort ? 0.54 : 0.72),
    },
    streamStartedAt: Date.now(),
  };
}

module.exports = {
  createStreamPlanState,
};
