"use strict";

const {
  gpuProgressFraction,
  logProfileStage,
} = require("./common");

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

  if (!canFuseAnyCpuLoudnormWithSplitStats(plan)) startCpuLoudnormTask(plan, { background: true });
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
    args.jobLog(`GPU normalize split stats prepass sample rate changed for ${planLabel}: cache=${activeSplitStatsTask.statsSampleRate} runtime=${statsSampleRate}; rerunning stats`);
    try {
      await activeSplitStatsTask.promise;
    } catch (err) {
      args.jobLog(`GPU normalize ignored stale split stats prepass for ${planLabel}: ${err.message}`);
    }
    activeSplitStatsTask = null;
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

module.exports = {
  resolveMeasuredSplitStats,
  startMeasuredSplitStatsPrepass,
};
