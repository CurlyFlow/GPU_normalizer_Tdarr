"use strict";

const {
  intNum,
} = require("./common");
const {
  sleep,
} = require("./shell");

function parallelSerialFallbackApplyDelayMs() {
  return Math.max(0, Math.min(60000, intNum(process.env.LOUDNORM_GPU_PARALLEL_SERIAL_FALLBACK_APPLY_DELAY_MS, 0)));
}

async function runSerialApplyDispatch({
  streamCtx,
  planState,
  splitStatsForPlan,
  measurement,
}) {
  const applyDelayMs = planState.plan.stereoFallback ? parallelSerialFallbackApplyDelayMs() : 0;
  if (applyDelayMs > 0) {
    streamCtx.execution.args.jobLog(`GPU normalize delaying parallel serial stereo fallback apply by ${applyDelayMs}ms`);
    await sleep(applyDelayMs);
  }
  const applyResult = await streamCtx.backend.run({
    planState,
    splitStatsForPlan,
    measurement,
  });
  if (applyResult.outputResult) return applyResult;
  const nextCompletedWork = planState.completedWork + planState.plan.work;
  streamCtx.progress.updateProgress(nextCompletedWork, true);
  return { completedWork: nextCompletedWork };
}

module.exports = {
  runSerialApplyDispatch,
};
