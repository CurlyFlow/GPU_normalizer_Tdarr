"use strict";

async function runSerialApplyDispatch({
  streamCtx,
  planState,
  splitStatsForPlan,
  measurement,
}) {
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
