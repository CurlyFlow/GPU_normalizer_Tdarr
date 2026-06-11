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
const {
  envFlag,
  intNum,
} = require("./common");
const {
  sleep,
} = require("./shell");

function parallelSerialFallbackStartDelayMs() {
  return Math.max(0, Math.min(60000, intNum(process.env.LOUDNORM_GPU_PARALLEL_SERIAL_FALLBACK_START_DELAY_MS, 24000)));
}

function prefetchDelayedFallbackMeasure() {
  return envFlag("LOUDNORM_GPU_PARALLEL_SERIAL_PREFETCH_DELAYED_FALLBACK_MEASURE")
    && envFlag("LOUDNORM_GPU_FIRST_PASS_ORIGINAL_ONLY", true);
}

async function runStreamProcessorRoute(streamExecutionContext) {
  if (streamExecutionContext.policy.useParallelSerialStreams) {
    const { execution, plans, policy, stats } = streamExecutionContext;
    const { processingPlans } = plans;
    const fallbackStartDelayMs = parallelSerialFallbackStartDelayMs();
    const prefetchFallbackMeasure = prefetchDelayedFallbackMeasure();
    execution.args.jobLog(`GPU normalize parallel serial stream probe enabled: ${Math.min(policy.streamParallelism, processingPlans.length)} concurrent streams inside this job`);
    const results = await runLimitedParallel(processingPlans, policy.streamParallelism, async (plan) => {
      if (plan.stereoFallback && fallbackStartDelayMs > 0) {
        if (prefetchFallbackMeasure) {
          execution.args.jobLog(`GPU normalize prefetching delayed parallel serial stereo fallback first pass during ${fallbackStartDelayMs}ms start delay`);
          stats.startCpuLoudnormTask(plan, { background: true });
        }
        execution.args.jobLog(`GPU normalize delaying parallel serial stereo fallback start by ${fallbackStartDelayMs}ms`);
        await sleep(fallbackStartDelayMs);
      }
      return await runSerialStreamPlan({
        streamCtx: streamExecutionContext,
        plan,
        completedWork: 0,
      });
    });
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
