"use strict";

function buildPairedApplyGpuPlans({
  pairedApplyConfig,
  pairedApplyStrategy,
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
  const { decode, nice, runtime } = pairedApplyStrategy;
  const fallbackRate = processingSampleRateFor(fallbackPlan, fallbackValues);
  const originalRate = processingSampleRateFor(originalPlan, originalValues);
  const fallbackDecodeCommand = decode.directFifoDecode ? ["__loudnorm_open_fifo__", fallbackPlan.fifoInput] : ["cat", fallbackPlan.fifoInput];
  const originalDecodeCommand = decode.directFifoDecode ? ["__loudnorm_open_fifo__", originalPlan.fifoInput] : ["cat", originalPlan.fifoInput];
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
  const fallbackGpuPlanCommand = nice.fallback > 0 ? `nice -n ${nice.fallback} ${fallbackGpuPlan}` : fallbackGpuPlan;
  const originalGpuPlanCommand = nice.original > 0 ? `nice -n ${nice.original} ${originalGpuPlan}` : originalGpuPlan;
  const singleRuntimeGpuPlan = runtime.single
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
