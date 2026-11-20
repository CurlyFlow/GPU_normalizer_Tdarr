"use strict";

const {
  envFlag,
  ffmpegProgressFraction,
  gpuProgressFraction,
  logProfileStage,
} = require("./common");
const {
  logCpuLoudnormMeasurement,
} = require("./cpuLoudnormTelemetry");
const {
  shouldDelayOriginalStatsForCpu,
} = require("./splitStatsPolicy");

function startMeasuredSplitStatsPrepass({
  plan,
  planLabel,
  completedWork,
  measureSpan,
  normalizeSpan,
  splitStatsForPlan,
  canFuseAnyCpuLoudnormWithSplitStats,
  startCpuLoudnormTask,
  startSplitStatsTask,
  splitPrefetchNextStatsAtProgress,
  splitPrefetchNextStatsDuringStats,
  prefetchNextSplitStats,
  updateProgress,
}) {
  if (!splitStatsForPlan) return null;

  const delayOriginalStatsForCpu = shouldDelayOriginalStatsForCpu(plan, canFuseAnyCpuLoudnormWithSplitStats);
  if (!canFuseAnyCpuLoudnormWithSplitStats(plan)) startCpuLoudnormTask(plan, { background: true });
  if (delayOriginalStatsForCpu) return null;

  let prefetchedNextStatsDuringCurrentStats = false;
  const splitStatsTask = startSplitStatsTask(plan, "before measured apply", (line) => {
    const fraction = gpuProgressFraction(line);
    if (fraction !== null) {
      updateProgress(completedWork + measureSpan + normalizeSpan * 0.5 * fraction);
      if (!prefetchedNextStatsDuringCurrentStats && splitPrefetchNextStatsAtProgress > 0 && fraction >= splitPrefetchNextStatsAtProgress) {
        prefetchedNextStatsDuringCurrentStats = prefetchNextSplitStats(plan, `after ${Math.round(splitPrefetchNextStatsAtProgress * 100)}% of ${planLabel} stats`);
      }
    }
  });
  if (splitPrefetchNextStatsDuringStats) prefetchNextSplitStats(plan, `while ${planLabel} stats runs`);
  return splitStatsTask;
}

async function resolveMeasuredSplitStats({
  args,
  plan,
  planLabel,
  completedWork,
  measureSpan,
  normalizeSpan,
  splitStatsForPlan,
  splitStatsTask,
  cpuLoudnormValues,
  processingOrder,
  processingSampleRateFor,
  startSplitStatsTask,
  prefetchNextSplitStats,
  prefetchNextCpuLoudnorm,
  updateProgress,
}) {
  let activeSplitStatsTask = splitStatsTask;
  let splitStatsCacheInput = null;
  const statsSampleRate = processingSampleRateFor(plan, cpuLoudnormValues);

  if (activeSplitStatsTask && activeSplitStatsTask.statsSampleRate !== statsSampleRate) {
    const keepDefaultRate = envFlag("LOUDNORM_GPU_KEEP_DEFAULT_RATE_ON_SPLIT_STATS_RATE_CHANGE", false)
      && !plan.stereoFallback
      && cpuLoudnormValues
      && activeSplitStatsTask.statsSampleRate > 0;
    args.jobLog(`GPU normalize split stats prepass sample rate changed for ${planLabel}: cache=${activeSplitStatsTask.statsSampleRate} runtime=${statsSampleRate}`);
    if (keepDefaultRate) {
      try {
        await activeSplitStatsTask.promise;
        cpuLoudnormValues._gpuKeepDefaultProcessingRate = true;
        args.jobLog(`GPU normalize keeping split stats prepass for ${planLabel} at cache rate ${activeSplitStatsTask.statsSampleRate}; forcing default processing rate instead of rerunning at ${statsSampleRate}`);
      } catch (err) {
        args.jobLog(`GPU normalize ignored stale split stats prepass for ${planLabel}: ${err.message}`);
        activeSplitStatsTask = null;
      }
    } else {
      args.jobLog(`GPU normalize rerunning split stats prepass for ${planLabel} at runtime rate ${statsSampleRate}`);
      try {
        await activeSplitStatsTask.promise;
      } catch (err) {
        args.jobLog(`GPU normalize ignored stale split stats prepass for ${planLabel}: ${err.message}`);
      }
      activeSplitStatsTask = null;
    }
  }

  if (splitStatsForPlan && !activeSplitStatsTask) {
    activeSplitStatsTask = startSplitStatsTask(plan, "after measured values", (line) => {
      const fraction = gpuProgressFraction(line);
      if (fraction !== null) updateProgress(completedWork + measureSpan + normalizeSpan * 0.5 * fraction);
    }, cpuLoudnormValues);
  }

  if (activeSplitStatsTask) {
    const statsRes = await activeSplitStatsTask.promise;
    splitStatsCacheInput = statsRes.statsCache || plan.statsCache;
    logProfileStage(args, { scope: "plugin", name: "gpu_source_port_streaming_stats", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: statsRes.wallSec });
  }

  prefetchNextSplitStats(plan, `while ${planLabel} apply runs`);
  prefetchNextCpuLoudnorm((processingOrder.get(plan.idx) || 0) + 1);
  return { splitStatsCacheInput };
}

async function measureStreamPlanLoudnorm({
  args,
  debugLogging,
  plan,
  planLabel,
  completedWork,
  measureSpan,
  durationSeconds,
  splitStatsTask,
  getCpuLoudnormRecord,
  targetI,
  maxGain,
  updateProgress,
}) {
  const measureRecord = await getCpuLoudnormRecord(plan, (line) => {
    const fraction = ffmpegProgressFraction(line, durationSeconds);
    if (fraction !== null) updateProgress(completedWork + measureSpan * fraction);
  });
  const cpuLoudnormValues = measureRecord.values;
  const firstPassStatsCacheInput = measureRecord.statsCache || null;
  const { skipNormalization } = logCpuLoudnormMeasurement({ args, debugLogging, plan, planLabel, measureRecord, values: cpuLoudnormValues, targetI, maxGain });
  updateProgress(completedWork + measureSpan, true);
  if (skipNormalization) {
    if (splitStatsTask) await splitStatsTask.promise;
    return {
      skipReason: `gain limit exceeded on ${planLabel}`,
      cpuLoudnormValues,
      firstPassStatsCacheInput,
    };
  }
  return {
    skipReason: "",
    cpuLoudnormValues,
    firstPassStatsCacheInput,
  };
}

async function prepareMeasuredSourcePortPlan({
  args,
  debugLogging,
  plan,
  planLabel,
  completedWork,
  measureSpan,
  normalizeSpan,
  durationSeconds,
  splitStatsForPlan,
  canFuseAnyCpuLoudnormWithSplitStats,
  startCpuLoudnormTask,
  startSplitStatsTask,
  getCpuLoudnormRecord,
  splitPrefetchNextStatsAtProgress,
  splitPrefetchNextStatsDuringStats,
  prefetchNextSplitStats,
  prefetchNextCpuLoudnorm,
  processingOrder,
  processingSampleRateFor,
  targetI,
  maxGain,
  updateProgress,
}) {
  let splitStatsCacheInput = null;
  const splitStatsTask = startMeasuredSplitStatsPrepass({
    plan,
    planLabel,
    completedWork,
    measureSpan,
    normalizeSpan,
    splitStatsForPlan,
    canFuseAnyCpuLoudnormWithSplitStats,
    startCpuLoudnormTask,
    startSplitStatsTask,
    splitPrefetchNextStatsAtProgress,
    splitPrefetchNextStatsDuringStats,
    prefetchNextSplitStats,
    updateProgress,
  });
  const measured = await measureStreamPlanLoudnorm({
    args,
    debugLogging,
    plan,
    planLabel,
    completedWork,
    measureSpan,
    durationSeconds,
    splitStatsTask,
    getCpuLoudnormRecord,
    targetI,
    maxGain,
    updateProgress,
  });
  const cpuLoudnormValues = measured.cpuLoudnormValues;
  const firstPassStatsCacheInput = measured.firstPassStatsCacheInput;
  if (measured.skipReason) {
    return {
      skipReason: measured.skipReason,
      cpuLoudnormValues,
      firstPassStatsCacheInput,
      splitStatsCacheInput,
    };
  }
  ({ splitStatsCacheInput } = await resolveMeasuredSplitStats({
    args,
    plan,
    planLabel,
    completedWork,
    measureSpan,
    normalizeSpan,
    splitStatsForPlan,
    splitStatsTask,
    cpuLoudnormValues,
    processingOrder,
    processingSampleRateFor,
    startSplitStatsTask,
    prefetchNextSplitStats,
    prefetchNextCpuLoudnorm,
    updateProgress,
  }));
  return {
    skipReason: "",
    cpuLoudnormValues,
    firstPassStatsCacheInput,
    splitStatsCacheInput,
  };
}

module.exports = {
  prepareMeasuredSourcePortPlan,
};
