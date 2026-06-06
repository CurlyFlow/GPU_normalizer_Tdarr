"use strict";

const {
  runLimitedParallel,
} = require("./runtimeExecution");
const {
  runSerialStreamPlan,
} = require("./streamSerialPlanRunner");
const {
  runStreamParallelProcessing,
} = require("./streamParallelProcessor");
const {
  runSerialStreamProcessing,
} = require("./streamSerialProcessor");

async function runStreamProcessorRoute(streamExecutionContext) {
  if (streamExecutionContext.policy.useParallelSerialStreams) {
    const { execution, plans, policy } = streamExecutionContext;
    const { processingPlans } = plans;
    execution.args.jobLog(`GPU normalize parallel serial stream probe enabled: ${Math.min(policy.streamParallelism, processingPlans.length)} concurrent streams inside this job`);
    const results = await runLimitedParallel(processingPlans, policy.streamParallelism, async (plan) => await runSerialStreamPlan({
      streamCtx: streamExecutionContext,
      plan,
      completedWork: 0,
    }));
    const outputResult = results.find((result) => result && result.outputResult);
    if (outputResult) return outputResult;
    return { completedWork: plans.audioWork };
  }
  if (streamExecutionContext.policy.useStreamParallelism) {
    return await runStreamParallelProcessing(streamExecutionContext);
  }
  return await runSerialStreamProcessing(streamExecutionContext);
}

module.exports = {
  runStreamProcessorRoute,
};
