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

async function runStreamParallelProcessing(streamCtx) {
  const { commands, execution, output, plans, policy, progress, stats } = streamCtx;
  const { processingPlans } = plans;
  const { streamParallelism } = policy;
  const { args, debugLogging, targetI, maxGain } = execution;
  args.jobLog(`GPU normalize stream parallelism enabled: ${Math.min(streamParallelism, processingPlans.length)} concurrent streams inside this job`);
  const planProgress = new Map(processingPlans.map((plan) => [plan.idx, 0]));
  const totalPlanProgress = () => Array.from(planProgress.values()).reduce((sum, value) => sum + value, 0);
  const reportPlanProgress = (plan, workDone, force = false) => {
    const bounded = Math.max(planProgress.get(plan.idx) || 0, Math.min(plan.work, workDone));
    planProgress.set(plan.idx, bounded);
    progress.updateProgress(totalPlanProgress(), force);
  };
  const { gainGate, measuredPlans } = await measureParallelStreams({
    args,
    debugLogging,
    processingPlans,
    streamParallelism,
    planLabelFor: plans.planLabelFor,
    describePlan: plans.describePlan,
    getCpuLoudnormRecord: stats.getCpuLoudnormRecord,
    targetI,
    maxGain,
    reportPlanProgress,
  });
  if (gainGate) {
    return { outputResult: await output.copyOriginalPackage(gainGate.copyOriginalReason, totalPlanProgress()) };
  }

  const parallelProcessGroup = { procs: new Set(), cancelled: false };
  const cancelParallelWork = () => {
    parallelProcessGroup.cancelled = true;
    for (const proc of Array.from(parallelProcessGroup.procs)) terminateShellProcess(proc);
  };
  const streamResults = await runLimitedParallel(processingPlans, streamParallelism, async (plan) => {
    const measured = measuredPlans.get(plan.idx);
    const planLabel = plans.planLabelFor(plan);
    return await runParallelApplyPlan({
      args,
      debugLogging,
      plan,
      measured,
      planLabel,
      describePlan: plans.describePlan,
      buildStreamingDecodeCommand: commands.buildStreamingDecodeCommand,
      buildStreamingEncodeCommand: commands.buildStreamingEncodeCommand,
      buildStreamingGpuPlan: commands.buildStreamingGpuPlan,
      wrapRuntimeProfile: commands.wrapRuntimeProfile,
      runShell: commands.runShell,
      runChecked: commands.runChecked,
      cleanupFilesForPlan: commands.cleanupFilesForPlan,
      processGroup: parallelProcessGroup,
      reportPlanProgress,
    });
  }, { onError: cancelParallelWork });
  const runtimeGate = streamResults.find((result) => result && result.copyOriginalReason);
  if (runtimeGate) {
    return { outputResult: await output.copyOriginalPackage(runtimeGate.copyOriginalReason, totalPlanProgress()) };
  }
  return { completedWork: plans.audioWork };
}

module.exports = {
  runStreamParallelProcessing,
};
