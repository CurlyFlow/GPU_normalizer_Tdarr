"use strict";

const {
  envFlag,
} = require("./common");

const FIRST_PASS_BACKEND = {
  MIXED: "mixed",
  PLAIN: "plain",
  FUSED: "fused",
};

function boundedEnvNumber(policy, name, fallback, min, max, truncate = false) {
  const rawValue = policy.envNumber(name, fallback);
  const value = truncate ? Math.trunc(rawValue) : rawValue;
  return Math.max(min, Math.min(max, value));
}

function createGpuFirstPassPlan({
  plan,
  writeStatsCache,
  parityPolicy,
  processingSampleRateFor,
  statsCachePathFor,
  trackStatsCachePath,
}) {
  const processingSampleRate = processingSampleRateFor(plan, null);
  const statsSampleRate = envFlag("LOUDNORM_GPU_FIRST_PASS_SOURCE_RATE") && plan.sourceSampleRate > 0
    ? plan.sourceSampleRate
    : processingSampleRate;
  const writeCompatibleStatsCache = writeStatsCache && statsSampleRate === processingSampleRate;
  const statsCache = writeCompatibleStatsCache ? statsCachePathFor(plan, statsSampleRate).replace(/\.stats\.bin$/, ".first-pass.stats.bin") : "";
  if (writeCompatibleStatsCache) trackStatsCachePath(plan, statsCache);

  const useFused = envFlag("LOUDNORM_GPU_FUSED_FIRST_PASS") && !plan.stereoFallback;
  if (useFused) {
    return {
      backend: FIRST_PASS_BACKEND.FUSED,
      processingSampleRate,
      statsCache,
      statsSampleRate,
      writeCompatibleStatsCache,
      writeStatsCache,
    };
  }

  const allowMixedStereo = plan.stereoFallback && parityPolicy.mixedStereoOffsetEps() !== 0;
  const useMixed = envFlag("LOUDNORM_GPU_FIRST_PASS_MIXED_SOURCE_OUTPUT", true)
    && (!plan.stereoFallback || allowMixedStereo)
    && plan.sourceSampleRate > 0
    && plan.sourceSampleRate !== processingSampleRate;
  if (!useMixed) {
    return {
      backend: FIRST_PASS_BACKEND.PLAIN,
      processingSampleRate,
      statsCache,
      statsSampleRate,
      writeCompatibleStatsCache,
      writeStatsCache,
    };
  }

  const mixedParallel = envFlag("LOUDNORM_GPU_FIRST_PASS_MIXED_PARALLEL", true);
  return {
    backend: FIRST_PASS_BACKEND.MIXED,
    mixedInputDelayMs: mixedParallel ? boundedEnvNumber(parityPolicy, "LOUDNORM_GPU_FIRST_PASS_MIXED_INPUT_DELAY_MS", 0, 0, 60000) : 0,
    mixedInputNice: mixedParallel ? boundedEnvNumber(parityPolicy, "LOUDNORM_GPU_FIRST_PASS_MIXED_INPUT_NICE", 0, 0, 19, true) : 0,
    mixedParallel,
    processingSampleRate,
    statsCache,
    statsSampleRate,
    writeCompatibleStatsCache,
    writeStatsCache,
  };
}

module.exports = {
  FIRST_PASS_BACKEND,
  createGpuFirstPassPlan,
};
