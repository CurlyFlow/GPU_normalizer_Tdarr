"use strict";

const {
  niceCommand,
} = require("./common");

function pairedDecodeCommand(plan, decode) {
  return decode.directFifoDecode ? ["__loudnorm_open_fifo__", plan.fifoInput] : ["cat", plan.fifoInput];
}

function pairedStatsCacheInput(plan, prep) {
  return prep.splitStatsCacheInput || plan.statsCache;
}

function buildPairedApplyRuntimePlans({
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
  const fallbackDecodeCommand = pairedDecodeCommand(fallbackPlan, decode);
  const originalDecodeCommand = pairedDecodeCommand(originalPlan, decode);
  const fallbackStatsCacheInput = pairedStatsCacheInput(fallbackPlan, fallbackPrep);
  const originalStatsCacheInput = pairedStatsCacheInput(originalPlan, originalPrep);
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
    fallbackGpuPlanCommand: niceCommand(fallbackGpuPlan, nice.fallback),
    fallbackRate,
    originalGpuPlanCommand: niceCommand(originalGpuPlan, nice.original),
    originalRate,
    singleRuntimeGpuPlan,
  };
}

module.exports = {
  buildPairedApplyRuntimePlans,
};
