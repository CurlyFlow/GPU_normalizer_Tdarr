"use strict";

const {
  loudnormNumber,
  parseLoudnormJsonFromOutputOrFile,
} = require("./common");
const {
  validatePlanStatsCache,
} = require("./statsCacheValidation");

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
  cpuLoudnormMeasurementStore,
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
    measureMode = { fused: false, kind: "none" },
    measureKey,
  }) => {
    const filterThreads = Math.max(0, Math.min(16, intNum(process.env.LOUDNORM_GPU_SPLIT_STATS_FILTER_THREADS, 0)));
    const filterThreadArgs = filterThreads > 0 ? ["-filter_threads", String(filterThreads)] : [];
    if (fuseCpuMeasure && !measureMode.fused) throw new Error(`split stats fused CPU mode missing for ${planLabel}`);
    if (measureMode.fused && measureMode.kind === "original" && !canFuseOriginalCpuLoudnormWithSplitStats(plan)) {
      throw new Error(`split stats original fused CPU mode is invalid for ${planLabel}`);
    }
    if (measureMode.fused && measureMode.kind === "stereo_fallback" && (plan.channels !== 2 || plan.channelLayout !== "stereo")) {
      throw new Error(`split stats stereo fallback fused CPU mode is invalid for ${planLabel}`);
    }
    const fusedFilterGraph = measureMode.kind === "original"
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
    args.jobLog(`GPU normalize split stats prepass enabled for ${planLabel} ${reason} rate=${statsSampleRate}${fuseCpuMeasure ? ` fused_cpu_loudnorm=${measureMode.kind}` : ""}`);
    const taskPromise = runShell(wrapRuntimeProfile(statsPlan, plan, "stats"), {
      args,
      label: `GPU streaming stats ${planLabel}`,
      allowedCodes: [0],
      capturePath: statsErr,
      logOnSuccess: debugLogging,
      parseLine,
    }).then((res) => {
      if (res.code !== 0) {
        const cacheValidation = validatePlanStatsCache(plan, statsSampleRate, statsCache);
        if (!cacheValidation.ok) throw new Error(`GPU streaming stats failed on ${planLabel}: ${cacheValidation.reason}`);
        args.jobLog(`GPU streaming stats ${planLabel} produced valid stats cache despite exit code ${res.code}${res.signal ? ` signal ${res.signal}` : ""}; continuing`);
      }
      const result = { ...res, statsSampleRate, statsCache };
      if (fuseCpuMeasure) {
        const values = parseLoudnormJsonFromOutputOrFile(res.output, statsErr);
        for (const loudnormKey of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) loudnormNumber(values, loudnormKey);
        const measureResult = {
          values,
          wallSec: 0,
          source: "fused_split_stats",
          background: false,
          queuedSec: 0,
          fusedStatsSec: res.wallSec,
        };
        cpuLoudnormMeasurementStore.publishFused(measureKey, measureResult);
        result.cpuLoudnormRecord = measureResult;
        args.jobLog(`GPU normalize CPU loudnorm first pass ${planLabel} fused with split stats: ${JSON.stringify(values)}`);
      }
      splitStatsResults.set(key, result);
      return result;
    });
    if (fuseCpuMeasure) cpuLoudnormMeasurementStore.publishTask(measureKey, taskPromise.then((result) => result.cpuLoudnormRecord));
    const taskRecord = { promise: taskPromise, statsSampleRate, statsCache };
    splitStatsTasks.set(key, taskRecord);
    return taskRecord;
  };
}

module.exports = {
  createSingleSplitStatsTaskStarter,
};
