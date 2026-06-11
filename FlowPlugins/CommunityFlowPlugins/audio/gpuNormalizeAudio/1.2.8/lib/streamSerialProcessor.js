"use strict";

const {
  runSerialStreamPlan,
} = require("./streamSerialPlanRunner");

async function runSerialStreamProcessing(streamExecutionContext) {
  const { processingPlans } = streamExecutionContext.plans;
  let completedWork = 0;
  for (const plan of processingPlans) {
    const planResult = await runSerialStreamPlan({
      streamCtx: streamExecutionContext,
      plan,
      completedWork,
    });
    if (planResult.outputResult) return planResult;
    completedWork = planResult.completedWork;
  }
  return { completedWork };
}

module.exports = {
  runSerialStreamProcessing,
};
