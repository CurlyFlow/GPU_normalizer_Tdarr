"use strict";

const {
  loudnormNumber,
  parseLoudnormJson,
} = require("./common");
const {
  validateLoudnormValues,
} = require("./cpuLoudnormTaskUtils");

function createGpuFirstPassTaskRunner({
  args,
  debugLogging,
  backgroundCpuGroup,
  buildGpuFirstPassMeasure,
  cpuLoudnormMeasurementStore,
  loudnessSummary,
  planLabelFor,
  processingSampleRateFor,
  runChecked,
  statsCachePathFor,
  trackStatsCachePath,
  wrapRuntimeProfile,
}) {
  const gpuFirstPassStatsPathFor = (plan, statsSampleRate) => statsCachePathFor(plan, statsSampleRate).replace(/\.stats\.bin$/, ".first-pass.stats.bin");

  const compareGpuFirstPassValues = (planLabel, cpuValues, gpuValues) => {
    const keys = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"];
    const diffs = keys.map((key) => `${key}=${(loudnormNumber(gpuValues, key) - loudnormNumber(cpuValues, key)).toFixed(4)}`);
    args.jobLog(`GPU normalize first-pass audit ${planLabel}: gpu=${JSON.stringify(gpuValues)} diff_vs_cpu ${diffs.join(" ")}`);
  };

  const runGpuFirstPassMeasure = async (plan, opts = {}) => {
    const background = opts.background === true;
    const writeStatsCache = opts.writeStatsCache === true;
    const planLabel = planLabelFor(plan);
    const statsSampleRate = processingSampleRateFor(plan, null);
    const statsCache = writeStatsCache ? gpuFirstPassStatsPathFor(plan, statsSampleRate) : "";
    if (writeStatsCache) trackStatsCachePath(plan, statsCache);
    const startedAt = Date.now();
    const measureRes = await runChecked(wrapRuntimeProfile(buildGpuFirstPassMeasure(plan, statsSampleRate, statsCache, writeStatsCache), plan, "first-pass"), {
      label: `${background ? "prefetch " : ""}GPU loudnorm first pass ${planLabel}`,
      capturePath: plan.measureErr,
      logOnSuccess: debugLogging && !background,
      processGroup: background ? backgroundCpuGroup : null,
      parseLine: background ? undefined : opts.parseLine,
    });
    const values = parseLoudnormJson(measureRes.output);
    validateLoudnormValues(values);
    values._gpuFirstPass = true;
    return {
      values,
      wallSec: measureRes.wallSec,
      source: writeStatsCache ? "gpu_first_pass" : "gpu_first_pass_audit",
      background,
      queuedSec: (startedAt - (opts.queuedAt || startedAt)) / 1000,
      statsSampleRate,
      statsCache: writeStatsCache ? statsCache : "",
    };
  };

  const startGpuFirstPassTask = (plan, { key, background, queuedAt, opts }) => {
    const planLabel = planLabelFor(plan);
    const task = runGpuFirstPassMeasure(plan, { ...opts, background, queuedAt, writeStatsCache: true }).then((result) => {
      cpuLoudnormMeasurementStore.publishRecord(key, result);
      if (!background) args.jobLog(`GPU Normalize Audio result: measured ${planLabel}: ${loudnessSummary(result.values)}.`);
      else if (debugLogging) args.jobLog(`GPU normalize GPU loudnorm first pass ${planLabel} prefetched: ${JSON.stringify(result.values)}`);
      return result;
    });
    if (background) {
      task.catch((err) => {
        if (!backgroundCpuGroup.cancelled) args.jobLog(`GPU normalize GPU loudnorm prefetch failed for ${planLabel}: ${err.message}`);
      });
    }
    return task;
  };

  return {
    compareGpuFirstPassValues,
    runGpuFirstPassMeasure,
    startGpuFirstPassTask,
  };
}

module.exports = {
  createGpuFirstPassTaskRunner,
};
