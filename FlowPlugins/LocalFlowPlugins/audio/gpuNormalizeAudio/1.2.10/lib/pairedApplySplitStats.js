"use strict";

const {
  gpuProgressFraction,
  logProfileStage,
} = require("./common");
const {
  shouldDelayOriginalStatsForCpu,
} = require("./splitStatsPolicy");

function pairedSplitStatsEnabled({
  plan,
  skipSplitStats,
  canSplitStatsPlan,
}) {
  return !skipSplitStats && canSplitStatsPlan(plan);
}

function startPairedSplitStatsPrepass({
  plan,
  measureSpan,
  normalizeSpan,
  progressBase,
  splitStatsForPlan,
  canFuseAnyCpuLoudnormWithSplitStats,
  startCpuLoudnormTask,
  startSplitStatsTask,
  updateProgress,
}) {
  if (!splitStatsForPlan) return null;
  const delayOriginalStatsForCpu = shouldDelayOriginalStatsForCpu(plan, canFuseAnyCpuLoudnormWithSplitStats);
  if (!canFuseAnyCpuLoudnormWithSplitStats(plan)) startCpuLoudnormTask(plan, { background: true });
  if (delayOriginalStatsForCpu) return null;
  return startSplitStatsTask(plan, "for paired apply", (line) => {
    const fraction = gpuProgressFraction(line);
    if (fraction !== null) updateProgress(progressBase + measureSpan + normalizeSpan * 0.35 * fraction);
  });
}

async function resolvePairedSplitStats({
  args,
  plan,
  planLabel,
  measureSpan,
  normalizeSpan,
  progressBase,
  splitStatsForPlan,
  splitStatsTask,
  cpuLoudnormValues,
  processingSampleRateFor,
  startSplitStatsTask,
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
    activeSplitStatsTask = startSplitStatsTask(plan, "after measured values for paired apply", (line) => {
      const fraction = gpuProgressFraction(line);
      if (fraction !== null) updateProgress(progressBase + measureSpan + normalizeSpan * 0.35 * fraction);
    }, cpuLoudnormValues);
  }
  if (activeSplitStatsTask) {
    const statsRes = await activeSplitStatsTask.promise;
    splitStatsCacheInput = statsRes.statsCache || plan.statsCache;
    logProfileStage(args, { scope: "plugin", name: "gpu_source_port_streaming_stats", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: statsRes.wallSec });
  }
  return { splitStatsCacheInput };
}

module.exports = {
  pairedSplitStatsEnabled,
  resolvePairedSplitStats,
  startPairedSplitStatsPrepass,
};
