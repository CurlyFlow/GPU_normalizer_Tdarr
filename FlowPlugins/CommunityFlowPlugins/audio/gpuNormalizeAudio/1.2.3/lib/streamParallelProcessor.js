"use strict";

const {
  runLimitedParallel,
} = require("./runtimeExecution");
const {
  terminateShellProcess,
} = require("./shell");
const {
  measureParallelStreams,
} = require("./streamParallelMeasurement");
const {
  runParallelApplyPlan,
} = require("./streamParallelApplyWorker");

async function runStreamParallelProcessing({
  args,
  debugLogging,
  processingPlans,
  streamParallelism,
  audioWork,
  updateProgress,
  planLabelFor,
  describePlan,
  getCpuLoudnormRecord,
  targetI,
  maxGain,
  buildStreamingDecodeCommand,
  buildStreamingEncodeCommand,
  buildStreamingGpuPlan,
  wrapRuntimeProfile,
  runShell,
  runChecked,
  cleanupFilesForPlan,
  copyOriginalPackage,
}) {
  args.jobLog(`GPU normalize stream parallelism enabled: ${Math.min(streamParallelism, processingPlans.length)} concurrent streams inside this job`);
  const planProgress = new Map(processingPlans.map((plan) => [plan.idx, 0]));
  const totalPlanProgress = () => Array.from(planProgress.values()).reduce((sum, value) => sum + value, 0);
  const reportPlanProgress = (plan, workDone, force = false) => {
    const bounded = Math.max(planProgress.get(plan.idx) || 0, Math.min(plan.work, workDone));
    planProgress.set(plan.idx, bounded);
    updateProgress(totalPlanProgress(), force);
  };
  const { gainGate, measuredPlans } = await measureParallelStreams({
    args,
    debugLogging,
    processingPlans,
    streamParallelism,
    planLabelFor,
    describePlan,
    getCpuLoudnormRecord,
    targetI,
    maxGain,
    reportPlanProgress,
  });
  if (gainGate) {
    return { outputResult: await copyOriginalPackage(gainGate.copyOriginalReason, totalPlanProgress()) };
  }

  const parallelProcessGroup = { procs: new Set(), cancelled: false };
  const cancelParallelWork = () => {
    parallelProcessGroup.cancelled = true;
    for (const proc of Array.from(parallelProcessGroup.procs)) terminateShellProcess(proc);
  };
  const streamResults = await runLimitedParallel(processingPlans, streamParallelism, async (plan) => {
    const measured = measuredPlans.get(plan.idx);
    const planLabel = planLabelFor(plan);
    return await runParallelApplyPlan({
      args,
      debugLogging,
      plan,
      measured,
      planLabel,
      describePlan,
      buildStreamingDecodeCommand,
      buildStreamingEncodeCommand,
      buildStreamingGpuPlan,
      wrapRuntimeProfile,
      runShell,
      runChecked,
      cleanupFilesForPlan,
      processGroup: parallelProcessGroup,
      reportPlanProgress,
    });
  }, { onError: cancelParallelWork });
  const runtimeGate = streamResults.find((result) => result && result.copyOriginalReason);
  if (runtimeGate) {
    return { outputResult: await copyOriginalPackage(runtimeGate.copyOriginalReason, totalPlanProgress()) };
  }
  return { completedWork: audioWork };
}

module.exports = {
  runStreamParallelProcessing,
};
