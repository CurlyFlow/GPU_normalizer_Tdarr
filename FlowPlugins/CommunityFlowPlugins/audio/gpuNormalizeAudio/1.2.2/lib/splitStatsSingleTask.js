"use strict";

const fs = require("fs");
const {
  loudnormNumber,
  parseLoudnormJson,
} = require("./common");

function intNum(value, fallback) {
  const num = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(num) ? num : fallback;
}

function createSingleSplitStatsTaskStarter({
  args,
  debugLogging,
  buildStatsRuntimePlan,
  loudnormFilter,
  decodeAudioArgs,
  runShell,
  wrapRuntimeProfile,
  canFuseOriginalCpuLoudnormWithSplitStats,
  cpuLoudnormResults,
  cpuLoudnormTasks,
  splitStatsResults,
  splitStatsTasks,
}) {
  return ({
    plan,
    statsSampleRate,
    statsCache,
    statsErr,
    key,
    planLabel,
    reason,
    parseLine,
    fuseCpuMeasure,
    measureKey,
  }) => {
    const filterThreads = Math.max(0, Math.min(16, intNum(process.env.LOUDNORM_GPU_SPLIT_STATS_FILTER_THREADS, 0)));
    const filterThreadArgs = filterThreads > 0 ? ["-filter_threads", String(filterThreads)] : [];
    const fusedFilterGraph = fuseCpuMeasure && canFuseOriginalCpuLoudnormWithSplitStats(plan)
      ? `[0:a:${plan.sourceAudioIdx}]asplit=2[measure_in][raw_in];[measure_in]${loudnormFilter()}[measure_out];[raw_in]aformat=channel_layouts=${plan.channelLayout}[gpu_raw]`
      : `[0:a:${plan.sourceAudioIdx}]aformat=channel_layouts=stereo,asplit=2[gpu_raw][measure_in];[measure_in]${loudnormFilter()}[measure_out]`;
    const statsDecodeCommand = fuseCpuMeasure ? [
      String(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-y", ...filterThreadArgs, "-i", String(plan.sourceInput),
      "-filter_complex", fusedFilterGraph,
      "-map", "[gpu_raw]", "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, "pipe:1",
      "-map", "[measure_out]", "-f", "null", (args.platform === "win32" ? "NUL" : "/dev/null"),
    ] : [
      String(args.ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", ...filterThreadArgs, "-i", String(plan.sourceInput),
      "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...decodeAudioArgs(plan), "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, "pipe:1",
    ];
    const statsPlan = buildStatsRuntimePlan(plan, statsSampleRate, statsCache, statsDecodeCommand);
    args.jobLog(`GPU normalize split stats prepass enabled for ${planLabel} ${reason} rate=${statsSampleRate}${fuseCpuMeasure ? " fused_cpu_loudnorm=true" : ""}`);
    const task = runShell(wrapRuntimeProfile(statsPlan, plan, "stats"), {
      args,
      label: `GPU streaming stats ${planLabel}`,
      allowedCodes: [0],
      capturePath: statsErr,
      logOnSuccess: debugLogging,
      parseLine,
    }).then((res) => {
      if (res.code !== 0) throw new Error(`GPU streaming stats failed on ${planLabel}`);
      const result = { ...res, statsSampleRate, statsCache };
      if (fuseCpuMeasure) {
        let loudnormText = res.output;
        if (!String(loudnormText || "").includes("target_offset") && fs.existsSync(statsErr)) loudnormText = fs.readFileSync(statsErr, "utf8");
        const values = parseLoudnormJson(loudnormText);
        for (const loudnormKey of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) loudnormNumber(values, loudnormKey);
        const measureResult = {
          values,
          wallSec: 0,
          source: "fused_split_stats",
          background: false,
          queuedSec: 0,
          fusedStatsSec: res.wallSec,
        };
        cpuLoudnormResults.set(measureKey, measureResult);
        result.cpuLoudnormRecord = measureResult;
        args.jobLog(`GPU normalize CPU loudnorm first pass ${planLabel} fused with split stats: ${JSON.stringify(values)}`);
      }
      splitStatsResults.set(key, result);
      return result;
    });
    if (fuseCpuMeasure) cpuLoudnormTasks.set(measureKey, task.then((result) => result.cpuLoudnormRecord));
    task.statsSampleRate = statsSampleRate;
    task.statsCache = statsCache;
    splitStatsTasks.set(key, task);
    return task;
  };
}

module.exports = {
  createSingleSplitStatsTaskStarter,
};
