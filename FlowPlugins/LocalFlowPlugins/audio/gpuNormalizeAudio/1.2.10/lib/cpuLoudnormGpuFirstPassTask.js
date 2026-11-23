"use strict";

const {
  createGpuFirstPassExecutionBackends,
} = require("./cpuLoudnormFirstPassBackends");
const {
  createGpuFirstPassPlan,
} = require("./cpuLoudnormFirstPassPlan");
const {
  loudnormNumber,
} = require("./common");

function envNumber(name, fallback = 0) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function createFirstPassParityPolicy() {
  const mixedStereoOffsetEps = () => envNumber("LOUDNORM_GPU_FIRST_PASS_MIXED_STEREO_OFFSET_EPS", 0);

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
    const bias = envNumber("LOUDNORM_GPU_FIRST_PASS_ORIGINAL_OFFSET_BIAS_DB", 0);
    if (bias === 0) return values;
    const minSeconds = envNumber("LOUDNORM_GPU_FIRST_PASS_ORIGINAL_OFFSET_BIAS_MIN_SECONDS", 120);
    const planSeconds = plan.channels > 0 ? Number(plan.work || 0) / plan.channels : 0;
    if (minSeconds > 0 && planSeconds > 0 && planSeconds < minSeconds) return values;
    values.target_offset = (loudnormNumber(values, "target_offset") + bias).toFixed(2);
    values.output_i = (loudnormNumber(values, "output_i") - bias).toFixed(2);
    values._gpuFirstPassOriginalOffsetBiasDb = bias;
    if (minSeconds > 0) values._gpuFirstPassOriginalOffsetBiasMinSeconds = minSeconds;
    return values;
  };

  const apply = (plan, values) => {
    applyMixedStereoOffsetEps(plan, values);
    applyOriginalOffsetBias(plan, values);
    return values;
  };

  return {
    apply,
    envNumber,
    mixedStereoOffsetEps,
  };
}

function compareGpuFirstPassValues(args, planLabel, cpuValues, gpuValues) {
  const keys = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"];
  const diffs = keys.map((key) => `${key}=${(loudnormNumber(gpuValues, key) - loudnormNumber(cpuValues, key)).toFixed(4)}`);
  args.jobLog(`GPU normalize first-pass audit ${planLabel}: gpu=${JSON.stringify(gpuValues)} diff_vs_cpu ${diffs.join(" ")}`);
}

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
  const parityPolicy = createFirstPassParityPolicy();
  const runFirstPassBackend = createGpuFirstPassExecutionBackends({
    args,
    debugLogging,
    backgroundCpuGroup,
    buildGpuFirstPassInputMeasure,
    buildGpuFirstPassMeasure,
    parityPolicy,
    runChecked,
    wrapRuntimeProfile,
  });
  const compareGpuFirstPassValuesForArgs = (planLabel, cpuValues, gpuValues) => compareGpuFirstPassValues(args, planLabel, cpuValues, gpuValues);

  const runGpuFirstPassMeasure = async (plan, opts = {}) => {
    const background = opts.background === true;
    const writeStatsCache = opts.writeStatsCache === true;
    const planLabel = planLabelFor(plan);
    const firstPassPlan = createGpuFirstPassPlan({
      plan,
      writeStatsCache,
      parityPolicy,
      processingSampleRateFor,
      statsCachePathFor,
      trackStatsCachePath,
    });
    const startedAt = Date.now();
    return await runFirstPassBackend({
      plan,
      firstPassPlan,
      task: {
        background,
        opts,
        planLabel,
        startedAt,
      },
    });
  };

  const startGpuFirstPassTask = (plan, { key, background, queuedAt, opts, measurementStore }) => {
    const store = measurementStore || cpuLoudnormMeasurementStore;
    const planLabel = planLabelFor(plan);
    const task = runGpuFirstPassMeasure(plan, { ...opts, background, queuedAt, writeStatsCache: true }).then((result) => {
      store.publishRecord(key, result);
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
    compareGpuFirstPassValues: compareGpuFirstPassValuesForArgs,
    runGpuFirstPassMeasure,
    startGpuFirstPassTask,
  };
}

module.exports = {
  createGpuFirstPassTaskRunner,
};
