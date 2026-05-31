"use strict";

const {
  ffmpegProgressFraction,
  gpuProgressFraction,
  logProfileStage,
} = require("./common");
const {
  logCpuLoudnormMeasurement,
} = require("./cpuLoudnormTelemetry");

async function preparePairedApplyPlan({
  args,
  debugLogging,
  plan,
  measureSpan,
  normalizeSpan,
  progressBase,
  durationSeconds,
  canSplitStatsPlan,
  canFuseAnyCpuLoudnormWithSplitStats,
  startCpuLoudnormTask,
  startSplitStatsTask,
  getCpuLoudnormRecord,
  processingSampleRateFor,
  planLabelFor,
  targetI,
  maxGain,
  updateProgress,
}) {
  const planLabel = planLabelFor(plan);
  const splitStatsForPlan = canSplitStatsPlan(plan);
  let splitStatsPromise = null;
  let splitStatsCacheInput = null;
  if (splitStatsForPlan) {
    if (!canFuseAnyCpuLoudnormWithSplitStats(plan)) startCpuLoudnormTask(plan, { background: true });
    splitStatsPromise = startSplitStatsTask(plan, "for paired apply", (line) => {
      const fraction = gpuProgressFraction(line);
      if (fraction !== null) updateProgress(progressBase + measureSpan + normalizeSpan * 0.35 * fraction);
    });
  }
  const measureRecord = await getCpuLoudnormRecord(plan, (line) => {
    const fraction = ffmpegProgressFraction(line, durationSeconds);
    if (fraction !== null) updateProgress(progressBase + measureSpan * fraction);
  });
  const cpuLoudnormValues = measureRecord.values;
  const { gainNeeded } = logCpuLoudnormMeasurement({ args, debugLogging, plan, planLabel, measureRecord, values: cpuLoudnormValues, targetI, maxGain });
  if (maxGain > 0 && gainNeeded > maxGain) {
    if (splitStatsPromise) await splitStatsPromise;
    return { copyOriginalReason: `GPU normalize gain gate exceeded on ${planLabel}; copying original package` };
  }
  const statsSampleRate = processingSampleRateFor(plan, cpuLoudnormValues);
  if (splitStatsPromise && splitStatsPromise.statsSampleRate !== statsSampleRate) {
    args.jobLog(`GPU normalize split stats prepass sample rate changed for ${planLabel}: cache=${splitStatsPromise.statsSampleRate} runtime=${statsSampleRate}; rerunning stats`);
    try {
      await splitStatsPromise;
    } catch (err) {
      args.jobLog(`GPU normalize ignored stale split stats prepass for ${planLabel}: ${err.message}`);
    }
    splitStatsPromise = null;
  }
  if (splitStatsForPlan && !splitStatsPromise) {
    splitStatsPromise = startSplitStatsTask(plan, "after measured values for paired apply", (line) => {
      const fraction = gpuProgressFraction(line);
      if (fraction !== null) updateProgress(progressBase + measureSpan + normalizeSpan * 0.35 * fraction);
    }, cpuLoudnormValues);
  }
  if (splitStatsPromise) {
    const statsRes = await splitStatsPromise;
    splitStatsCacheInput = statsRes.statsCache || plan.statsCache;
    logProfileStage(args, { scope: "plugin", name: "gpu_source_port_streaming_stats", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: statsRes.wallSec });
  }
  return { cpuLoudnormValues, splitStatsCacheInput };
}

module.exports = {
  preparePairedApplyPlan,
};
