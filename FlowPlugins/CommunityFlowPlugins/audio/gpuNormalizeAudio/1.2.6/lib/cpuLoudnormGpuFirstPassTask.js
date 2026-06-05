"use strict";

const {
  envFlag,
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
  buildGpuFirstPassInputMeasure,
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
  const gpuFirstPassSampleRateFor = (plan) => {
    if (envFlag("LOUDNORM_GPU_FIRST_PASS_SOURCE_RATE") && plan.sourceSampleRate > 0) return plan.sourceSampleRate;
    return processingSampleRateFor(plan, null);
  };

  const mixedStereoOffsetEps = () => {
    const raw = process.env.LOUDNORM_GPU_FIRST_PASS_MIXED_STEREO_OFFSET_EPS;
    const value = raw === undefined || raw === "" ? 0 : Number(raw);
    return Number.isFinite(value) ? value : 0;
  };

  const envNumber = (name) => {
    const raw = process.env[name];
    const value = raw === undefined || raw === "" ? 0 : Number(raw);
    return Number.isFinite(value) ? value : 0;
  };

  const applyMixedStereoOffsetEps = (plan, values) => {
    if (!plan.stereoFallback) return values;
    const eps = mixedStereoOffsetEps();
    if (eps !== 0) {
      values.target_offset = (loudnormNumber(values, "target_offset") + eps).toFixed(2);
      values.output_i = (loudnormNumber(values, "output_i") - eps).toFixed(2);
      values._gpuFirstPassMixedStereoOffsetEps = eps;
    }
    const inputBias = envNumber("LOUDNORM_GPU_FIRST_PASS_STEREO_INPUT_BIAS_DB");
    if (inputBias !== 0) {
      values.input_i = (loudnormNumber(values, "input_i") + inputBias).toFixed(2);
      values.input_thresh = (loudnormNumber(values, "input_thresh") + inputBias).toFixed(2);
      values._gpuFirstPassStereoInputBiasDb = inputBias;
    }
    const lraBias = envNumber("LOUDNORM_GPU_FIRST_PASS_STEREO_LRA_BIAS_DB");
    if (lraBias !== 0) {
      values.input_lra = (loudnormNumber(values, "input_lra") + lraBias).toFixed(2);
      values._gpuFirstPassStereoLraBiasDb = lraBias;
    }
    return values;
  };

  const applyOriginalOffsetBias = (plan, values) => {
    if (plan.stereoFallback) return values;
    const bias = envNumber("LOUDNORM_GPU_FIRST_PASS_ORIGINAL_OFFSET_BIAS_DB");
    if (bias === 0) return values;
    const minSeconds = envNumber("LOUDNORM_GPU_FIRST_PASS_ORIGINAL_OFFSET_BIAS_MIN_SECONDS");
    const planSeconds = plan.channels > 0 ? Number(plan.work || 0) / plan.channels : 0;
    if (minSeconds > 0 && planSeconds > 0 && planSeconds < minSeconds) return values;
    values.target_offset = (loudnormNumber(values, "target_offset") + bias).toFixed(2);
    values.output_i = (loudnormNumber(values, "output_i") - bias).toFixed(2);
    values._gpuFirstPassOriginalOffsetBiasDb = bias;
    if (minSeconds > 0) values._gpuFirstPassOriginalOffsetBiasMinSeconds = minSeconds;
    return values;
  };

  const compareGpuFirstPassValues = (planLabel, cpuValues, gpuValues) => {
    const keys = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"];
    const diffs = keys.map((key) => `${key}=${(loudnormNumber(gpuValues, key) - loudnormNumber(cpuValues, key)).toFixed(4)}`);
    args.jobLog(`GPU normalize first-pass audit ${planLabel}: gpu=${JSON.stringify(gpuValues)} diff_vs_cpu ${diffs.join(" ")}`);
  };

  const runGpuFirstPassMeasure = async (plan, opts = {}) => {
    const background = opts.background === true;
    const writeStatsCache = opts.writeStatsCache === true;
    const planLabel = planLabelFor(plan);
    const processingSampleRate = processingSampleRateFor(plan, null);
    const statsSampleRate = gpuFirstPassSampleRateFor(plan);
    const writeCompatibleStatsCache = writeStatsCache && statsSampleRate === processingSampleRate;
    const statsCache = writeCompatibleStatsCache ? gpuFirstPassStatsPathFor(plan, statsSampleRate) : "";
    if (writeCompatibleStatsCache) trackStatsCachePath(plan, statsCache);
    const startedAt = Date.now();
    const allowMixedStereo = plan.stereoFallback && mixedStereoOffsetEps() !== 0;
    if (envFlag("LOUDNORM_GPU_FIRST_PASS_MIXED_SOURCE_OUTPUT", true) && (!plan.stereoFallback || allowMixedStereo) && plan.sourceSampleRate > 0 && plan.sourceSampleRate !== processingSampleRate) {
      const inputRes = await runChecked(wrapRuntimeProfile(buildGpuFirstPassInputMeasure(plan, processingSampleRate, statsCache, writeCompatibleStatsCache), plan, "first-pass-input"), {
        label: `${background ? "prefetch " : ""}GPU loudnorm first pass input ${planLabel}`,
        capturePath: plan.measureErr,
        logOnSuccess: debugLogging && !background,
        processGroup: background ? backgroundCpuGroup : null,
        parseLine: background ? undefined : opts.parseLine,
      });
      const outputRes = await runChecked(wrapRuntimeProfile(buildGpuFirstPassMeasure(plan, plan.sourceSampleRate, "", false), plan, "first-pass-output"), {
        label: `${background ? "prefetch " : ""}GPU loudnorm first pass output ${planLabel}`,
        capturePath: plan.measureErr,
        logOnSuccess: debugLogging && !background,
        processGroup: background ? backgroundCpuGroup : null,
        parseLine: background ? undefined : opts.parseLine,
      });
      const inputValues = parseLoudnormJson(inputRes.output);
      const outputValues = parseLoudnormJson(outputRes.output);
      const values = {
        ...outputValues,
        input_i: inputValues.input_i,
        input_tp: inputValues.input_tp,
        input_lra: inputValues.input_lra,
        input_thresh: inputValues.input_thresh,
      };
      applyMixedStereoOffsetEps(plan, values);
      applyOriginalOffsetBias(plan, values);
      validateLoudnormValues(values);
      values._gpuFirstPass = true;
      values._gpuFirstPassMixed = true;
      return {
        values,
        wallSec: inputRes.wallSec + outputRes.wallSec,
        source: writeStatsCache ? "gpu_first_pass_mixed" : "gpu_first_pass_mixed_audit",
        background,
        queuedSec: (startedAt - (opts.queuedAt || startedAt)) / 1000,
        statsSampleRate: processingSampleRate,
        statsCache,
      };
    }
    const measureRes = await runChecked(wrapRuntimeProfile(buildGpuFirstPassMeasure(plan, statsSampleRate, statsCache, writeCompatibleStatsCache), plan, "first-pass"), {
      label: `${background ? "prefetch " : ""}GPU loudnorm first pass ${planLabel}`,
      capturePath: plan.measureErr,
      logOnSuccess: debugLogging && !background,
      processGroup: background ? backgroundCpuGroup : null,
      parseLine: background ? undefined : opts.parseLine,
    });
    const values = parseLoudnormJson(measureRes.output);
    applyMixedStereoOffsetEps(plan, values);
    applyOriginalOffsetBias(plan, values);
    validateLoudnormValues(values);
    values._gpuFirstPass = true;
    return {
      values,
      wallSec: measureRes.wallSec,
      source: writeStatsCache ? "gpu_first_pass" : "gpu_first_pass_audit",
      background,
      queuedSec: (startedAt - (opts.queuedAt || startedAt)) / 1000,
      statsSampleRate,
      statsCache,
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
