"use strict";

function buildPairedApplyGpuPlans({
  pairedApplyConfig,
  fallbackPlan,
  originalPlan,
  fallbackValues,
  originalValues,
  fallbackPrep,
  originalPrep,
  fallbackEncodeCommand,
  originalEncodeCommand,
  processingSampleRateFor,
  buildStreamingGpuPlan,
  buildPairedStreamingGpuPlan,
  wrapRuntimeProfile,
}) {
  const {
    pairStereoFallbackApplyDirectFifoDecode,
    pairStereoFallbackApplyOriginalNice,
    pairStereoFallbackApplySingleRuntime,
    pairStereoFallbackApplyStereoNice,
  } = pairedApplyConfig;
  const fallbackRate = processingSampleRateFor(fallbackPlan, fallbackValues);
  const originalRate = processingSampleRateFor(originalPlan, originalValues);
  const fallbackDecodeCommand = pairStereoFallbackApplyDirectFifoDecode ? ["__loudnorm_open_fifo__", fallbackPlan.fifoInput] : ["cat", fallbackPlan.fifoInput];
  const originalDecodeCommand = pairStereoFallbackApplyDirectFifoDecode ? ["__loudnorm_open_fifo__", originalPlan.fifoInput] : ["cat", originalPlan.fifoInput];
  const fallbackStatsCacheInput = fallbackPrep.splitStatsCacheInput || fallbackPlan.statsCache;
  const originalStatsCacheInput = originalPrep.splitStatsCacheInput || originalPlan.statsCache;
  const fallbackGpuPlan = wrapRuntimeProfile(
    buildStreamingGpuPlan(fallbackPlan, fallbackValues, fallbackDecodeCommand, fallbackEncodeCommand, fallbackStatsCacheInput),
    fallbackPlan,
    "paired-apply",
  );
  const originalGpuPlan = wrapRuntimeProfile(
    buildStreamingGpuPlan(originalPlan, originalValues, originalDecodeCommand, originalEncodeCommand, originalStatsCacheInput),
    originalPlan,
    "paired-apply",
  );
  const fallbackGpuPlanCommand = pairStereoFallbackApplyStereoNice > 0 ? `nice -n ${pairStereoFallbackApplyStereoNice} ${fallbackGpuPlan}` : fallbackGpuPlan;
  const originalGpuPlanCommand = pairStereoFallbackApplyOriginalNice > 0 ? `nice -n ${pairStereoFallbackApplyOriginalNice} ${originalGpuPlan}` : originalGpuPlan;
  const singleRuntimeGpuPlan = pairStereoFallbackApplySingleRuntime
    ? wrapRuntimeProfile(buildPairedStreamingGpuPlan(
      fallbackPlan,
      fallbackValues,
      fallbackDecodeCommand,
      fallbackEncodeCommand,
      fallbackStatsCacheInput,
      originalPlan,
      originalValues,
      originalDecodeCommand,
      originalEncodeCommand,
      originalStatsCacheInput,
    ), fallbackPlan, "paired-apply-single-runtime")
    : "";

  return {
    fallbackDecodeCommand,
    fallbackGpuPlanCommand,
    fallbackRate,
    originalDecodeCommand,
    originalGpuPlanCommand,
    originalRate,
    singleRuntimeGpuPlan,
  };
}

module.exports = {
  buildPairedApplyGpuPlans,
};
