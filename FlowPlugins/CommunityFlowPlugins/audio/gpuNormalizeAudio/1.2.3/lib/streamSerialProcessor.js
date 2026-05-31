"use strict";

const {
  runSerialStreamPlan,
} = require("./streamSerialPlanRunner");

async function runSerialStreamProcessing(streamExecutionContext, createPlanRunContext) {
  const { processingPlans } = streamExecutionContext.plans;
  let completedWork = 0;
  for (const plan of processingPlans) {
    const planResult = await runSerialStreamPlan(createPlanRunContext(streamExecutionContext, {
      plan,
      completedWork,
    }));
    if (planResult.outputResult) return planResult;
    completedWork = planResult.completedWork;
  }
  return { completedWork };
}

module.exports = {
  runSerialStreamProcessing,
};
