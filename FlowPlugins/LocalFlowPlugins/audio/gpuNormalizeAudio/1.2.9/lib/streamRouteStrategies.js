"use strict";

const {
  runLimitedParallel,
} = require("./runtimeExecution");
const {
  prepareMeasuredSourcePortPlan,
} = require("./streamPlanPreparation");
const {
  envFlag,
  gpuProgressFraction,
  intNum,
  logProfileStage,
  num,
} = require("./common");
const {
  sleep,
  terminateShellProcess,
} = require("./shell");
const {
  logCpuLoudnormMeasurement,
} = require("./cpuLoudnormTelemetry");
const {
  finishCompletedStream,
} = require("./streamCompletionTelemetry");

function boundedDelayMs(name, fallback) {
  return Math.max(0, Math.min(60000, intNum(process.env[name], fallback)));
}

function boundedFraction(name, fallback) {
  return Math.max(0, Math.min(1, num(process.env[name], fallback)));
}

function parallelSerialFallbackStartDelayMs() {
  return boundedDelayMs("LOUDNORM_GPU_PARALLEL_SERIAL_FALLBACK_START_DELAY_MS", 0);
}

function parallelSerialFallbackStartOriginalProgress() {
  return boundedFraction("LOUDNORM_GPU_PARALLEL_SERIAL_FALLBACK_START_ORIGINAL_PROGRESS", 0);
}

function parallelSerialFallbackApplyDelayMs() {
  return boundedDelayMs("LOUDNORM_GPU_PARALLEL_SERIAL_FALLBACK_APPLY_DELAY_MS", 0);
}

function prefetchDelayedFallbackMeasure(gpuFirstPassOriginalOnly) {
  return envFlag("LOUDNORM_GPU_PARALLEL_SERIAL_PREFETCH_DELAYED_FALLBACK_MEASURE", true)
    && gpuFirstPassOriginalOnly;
}

function createOriginalProgressGate(threshold) {
  let originalProgress = 0;
  let originalDone = false;
  const waiters = [];

  const notify = () => {
    if (!originalDone && originalProgress < threshold) return;
    while (waiters.length > 0) waiters.shift()(originalProgress);
  };

  return {
    enabled: threshold > 0,
    threshold,
    current: () => originalProgress,
    complete: (plan) => {
      if (plan.stereoFallback) return;
      originalDone = true;
      originalProgress = Math.max(originalProgress, 1);
      notify();
    },
    update: (plan, fraction) => {
      if (plan.stereoFallback || !Number.isFinite(fraction)) return;
      originalProgress = Math.max(originalProgress, Math.max(0, Math.min(1, fraction)));
      notify();
    },
    waitForOriginal: async () => {
      if (originalDone || originalProgress >= threshold) return originalProgress;
      return await new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function createSerialApplyDelayHook() {
  const applyDelayMs = parallelSerialFallbackApplyDelayMs();
  return async ({ streamCtx, plan }) => {
    if (!plan.stereoFallback || applyDelayMs <= 0) return;
    streamCtx.execution.args.jobLog(`GPU normalize delaying parallel serial stereo fallback apply by ${applyDelayMs}ms`);
    await sleep(applyDelayMs);
  };
}

async function runParallelApplyPlan({
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
  processGroup,
  reportPlanProgress,
}) {
  const cpuLoudnormValues = measured.cpuLoudnormValues;
  const measureSpan = plan.work * 0.18;
  const decodeSpan = plan.work * 0.08;
  const normalizeSpan = plan.work * 0.54;
  const encodeSpan = plan.work * 0.2;
  const decodeCommand = buildStreamingDecodeCommand(plan, cpuLoudnormValues);
  const encodeCommand = buildStreamingEncodeCommand(plan, cpuLoudnormValues);
  const gpuPlan = buildStreamingGpuPlan(plan, cpuLoudnormValues, decodeCommand, encodeCommand, "");
  const gpuRes = await runShell(wrapRuntimeProfile(gpuPlan, plan, "streaming"), {
    args,
    label: `GPU streaming normalize ${planLabel}`,
    allowedCodes: [0, 42],
    capturePath: plan.sourceErr,
    logOnSuccess: debugLogging,
    processGroup,
    parseLine: (line) => {
      const fraction = gpuProgressFraction(line);
      if (fraction !== null) reportPlanProgress(plan, measureSpan + decodeSpan + normalizeSpan * fraction);
    },
  });
  logProfileStage(args, { scope: "plugin", name: "gpu_source_port_streaming", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: gpuRes.wallSec });
  if (gpuRes.code === 42) {
    throw new Error(`GPU gain gate disagrees with the measured per-stream decision on ${planLabel}`);
  }
  if (gpuRes.code !== 0) throw new Error(`GPU streaming normalize failed on ${planLabel}`);
  reportPlanProgress(plan, measureSpan + decodeSpan + normalizeSpan + encodeSpan, true);
  await finishCompletedStream({
    args,
    plan,
    planLabel,
    describePlan,
    streamStartedAt: measured.streamStartedAt,
    cleanupFiles: cleanupFilesForPlan(plan).filter((file) => file !== plan.normalizedAudio),
    runChecked,
  });
  reportPlanProgress(plan, plan.work, true);
  return { completed: true };
}

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
  const measuredPlans = new Map();
  await runLimitedParallel(processingPlans, streamParallelism, async (plan) => {
    const streamStartedAt = Date.now();
    const planLabel = plans.planLabelFor(plan);
    args.jobLog(`GPU Normalize Audio step: ${plans.describePlan(plan)}.`);
    const measureSpan = plan.work * 0.18;
    const measureRecord = await stats.getCpuLoudnormRecord(plan);
    const cpuLoudnormValues = measureRecord.values;
    const { skipNormalization } = logCpuLoudnormMeasurement({ args, debugLogging, plan, planLabel, measureRecord, values: cpuLoudnormValues, targetI, maxGain });
    reportPlanProgress(plan, measureSpan, true);
    measuredPlans.set(plan.idx, { cpuLoudnormValues, streamStartedAt, skipNormalization });
    if (skipNormalization) {
      await output.skipNormalization(plan, `gain limit exceeded on ${planLabel}`);
      reportPlanProgress(plan, plan.work, true);
    }
  });

  const parallelProcessGroup = { procs: new Set(), cancelled: false };
  const cancelParallelWork = () => {
    parallelProcessGroup.cancelled = true;
    for (const proc of Array.from(parallelProcessGroup.procs)) terminateShellProcess(proc);
  };
  await runLimitedParallel(processingPlans, streamParallelism, async (plan) => {
    const measured = measuredPlans.get(plan.idx);
    if (measured.skipNormalization) return;
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
  return { completedWork: plans.audioWork };
}

async function runSerialApplyRoute({
  streamCtx,
  planState,
}) {
  const { commands, execution, output, plans, progress, stats } = streamCtx;
  const { completedWork, plan, planLabel, spans } = planState;
  const splitStatsForPlan = stats.canSplitStatsPlan(plan);
  const measurement = {
    cpuLoudnormValues: null,
    firstPassStatsCacheInput: null,
    splitStatsCacheInput: null,
  };
  if (execution.useGpuSourcePort) {
    const measuredPlan = await prepareMeasuredSourcePortPlan({
      args: execution.args,
      debugLogging: execution.debugLogging,
      plan,
      planLabel,
      completedWork,
      measureSpan: spans.measure,
      normalizeSpan: spans.normalize,
      durationSeconds: execution.durationSeconds,
      splitStatsForPlan,
      canFuseAnyCpuLoudnormWithSplitStats: stats.canFuseAnyCpuLoudnormWithSplitStats,
      startCpuLoudnormTask: stats.startCpuLoudnormTask,
      startSplitStatsTask: stats.startSplitStatsTask,
      getCpuLoudnormRecord: stats.getCpuLoudnormRecord,
      splitPrefetchNextStatsAtProgress: stats.splitPrefetchNextStatsAtProgress,
      splitPrefetchNextStatsDuringStats: stats.splitPrefetchNextStatsDuringStats,
      prefetchNextSplitStats: stats.prefetchNextSplitStats,
      prefetchNextCpuLoudnorm: stats.prefetchNextCpuLoudnorm,
      processingOrder: plans.processingOrder,
      processingSampleRateFor: commands.processingSampleRateFor,
      targetI: execution.targetI,
      maxGain: execution.maxGain,
      updateProgress: progress.updateProgress,
    });
    if (measuredPlan.skipReason) {
      await output.skipNormalization(plan, measuredPlan.skipReason);
      progress.updateProgress(completedWork + plan.work, true);
      return { completedWork: completedWork + plan.work };
    }
    measurement.cpuLoudnormValues = measuredPlan.cpuLoudnormValues;
    measurement.firstPassStatsCacheInput = measuredPlan.firstPassStatsCacheInput;
    measurement.splitStatsCacheInput = measuredPlan.splitStatsCacheInput;
  }

  if (streamCtx.route && typeof streamCtx.route.beforeSerialApply === "function") {
    await streamCtx.route.beforeSerialApply({ streamCtx, plan });
  }
  const applyResult = await streamCtx.backend.run({
    planState,
    splitStatsForPlan,
    measurement,
  });
  if (applyResult.outputResult) return applyResult;
  const nextCompletedWork = completedWork + plan.work;
  progress.updateProgress(nextCompletedWork, true);
  return { completedWork: nextCompletedWork };
}

async function runSerialStreamPlan({
  streamCtx,
  plan,
  completedWork,
  onPlanGpuProgress = null,
}) {
  const { execution, pairedApply, plans, progress } = streamCtx;
  const { pairedApplyCompleted, pairedFallbackApplyPartner, runPairedFallbackApply } = pairedApply;
  const planState = {
    completedWork,
    plan,
    planLabel: plans.planLabelFor(plan),
    onPlanGpuProgress,
    spans: {
      decode: plan.work * 0.08,
      encode: plan.work * 0.2,
      measure: execution.useGpuSourcePort ? plan.work * 0.18 : 0,
      normalize: plan.work * (execution.useGpuSourcePort ? 0.54 : 0.72),
    },
    streamStartedAt: Date.now(),
  };
  if (pairedApplyCompleted.has(plan.idx)) return { completedWork };
  execution.args.jobLog(`GPU Normalize Audio step: ${plans.describePlan(plan)}.`);

  const pairedApplyPartner = pairedFallbackApplyPartner(plan);
  if (pairedApplyPartner && !pairedApplyCompleted.has(pairedApplyPartner.idx)) {
    const pairRes = await runPairedFallbackApply(plan, pairedApplyPartner, completedWork, streamCtx.output.skipNormalization);
    if (pairRes.separateApply) {
      return await runSerialApplyRoute({ streamCtx, planState });
    }
    const nextCompletedWork = completedWork + plan.work + pairedApplyPartner.work;
    progress.updateProgress(nextCompletedWork, true);
    return { completedWork: nextCompletedWork };
  }

  return await runSerialApplyRoute({
    streamCtx,
    planState,
  });
}

function createSerialStreamStrategy() {
  return {
    kind: "serial",
    beforeSerialApply: createSerialApplyDelayHook(),
    async run(streamCtx) {
      const { processingPlans } = streamCtx.plans;
      let completedWork = 0;
      for (const plan of processingPlans) {
        const planResult = await runSerialStreamPlan({
          streamCtx,
          plan,
          completedWork,
        });
        if (planResult.outputResult) return planResult;
        completedWork = planResult.completedWork;
      }
      return { completedWork };
    },
  };
}

function createParallelStreamStrategy() {
  return {
    kind: "parallel",
    beforeSerialApply: createSerialApplyDelayHook(),
    run: runStreamParallelProcessing,
  };
}

function createParallelSerialPairStrategy({ gpuFirstPassOriginalOnly }) {
  const fallbackStartDelayMs = parallelSerialFallbackStartDelayMs();
  const fallbackStartOriginalProgress = parallelSerialFallbackStartOriginalProgress();
  const originalProgressGate = createOriginalProgressGate(fallbackStartOriginalProgress);
  const prefetchFallbackMeasure = prefetchDelayedFallbackMeasure(gpuFirstPassOriginalOnly);
  return {
    kind: "parallelSerialPair",
    beforeSerialApply: createSerialApplyDelayHook(),
    async beforePlanStart({ streamCtx, plan }) {
      if (!plan.stereoFallback) return;
      const { execution, stats } = streamCtx;
      if (originalProgressGate.enabled) {
        if (prefetchFallbackMeasure) {
          execution.args.jobLog(`GPU normalize prefetching delayed parallel serial stereo fallback first pass during original progress start gate`);
          stats.startCpuLoudnormTask(plan, { background: true });
        }
        execution.args.jobLog(`GPU normalize delaying parallel serial stereo fallback start until original progress ${(originalProgressGate.threshold * 100).toFixed(1)}%`);
        await originalProgressGate.waitForOriginal();
        execution.args.jobLog(`GPU normalize starting parallel serial stereo fallback after original progress ${(originalProgressGate.current() * 100).toFixed(1)}%`);
        return;
      }
      if (fallbackStartDelayMs <= 0) return;
      if (prefetchFallbackMeasure) {
        execution.args.jobLog(`GPU normalize prefetching delayed parallel serial stereo fallback first pass during ${fallbackStartDelayMs}ms start delay`);
        stats.startCpuLoudnormTask(plan, { background: true });
      }
      execution.args.jobLog(`GPU normalize delaying parallel serial stereo fallback start by ${fallbackStartDelayMs}ms`);
      await sleep(fallbackStartDelayMs);
    },
    async run(streamCtx) {
      const { execution, plans, policy } = streamCtx;
      const { processingPlans } = plans;
      execution.args.jobLog(`GPU normalize parallel serial stream probe enabled: ${Math.min(policy.streamParallelism, processingPlans.length)} concurrent streams inside this job`);
      const results = await runLimitedParallel(processingPlans, policy.streamParallelism, async (plan) => {
        await this.beforePlanStart({ streamCtx, plan });
        try {
          return await runSerialStreamPlan({
            streamCtx,
            plan,
            completedWork: 0,
            onPlanGpuProgress: originalProgressGate.enabled ? originalProgressGate.update : null,
          });
        } finally {
          if (originalProgressGate.enabled) originalProgressGate.complete(plan);
        }
      });
      const outputResult = results.find((result) => result && result.outputResult);
      if (outputResult) return outputResult;
      return { completedWork: plans.audioWork };
    },
  };
}

function createStreamRouteStrategy(kind, options = {}) {
  if (kind === "parallelSerialPair") return createParallelSerialPairStrategy(options);
  if (kind === "parallel") return createParallelStreamStrategy();
  return createSerialStreamStrategy();
}

module.exports = {
  createStreamRouteStrategy,
};
