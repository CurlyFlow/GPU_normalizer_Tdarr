"use strict";

const {
  envFlag,
  intNum,
} = require("./common");

function createProcessingOrder({
  audioPlans,
  useGpuSourcePort,
  gpuFirstPassMeasure,
}) {
  const fallbackPlans = audioPlans.filter((plan) => plan.stereoFallback);
  const fallbackFirst = envFlag("LOUDNORM_GPU_FALLBACK_FIRST", true);
  const earlyCpuPrefetch = !gpuFirstPassMeasure && envFlag("LOUDNORM_GPU_CPU_LOUDNORM_EARLY_PREFETCH", true);
  const earlyCpuPrefetchLimit = Math.max(1, intNum(process.env.LOUDNORM_GPU_CPU_LOUDNORM_EARLY_PREFETCH_LIMIT, 2));
  const processingPlans = useGpuSourcePort && fallbackFirst && fallbackPlans.length > 0
    ? [...fallbackPlans, ...audioPlans.filter((plan) => !plan.stereoFallback)]
    : audioPlans;
  const processingOrder = new Map(processingPlans.map((plan, idx) => [plan.idx, idx]));

  return {
    earlyCpuPrefetch,
    earlyCpuPrefetchLimit,
    fallbackPlans,
    processingOrder,
    processingPlans,
  };
}

module.exports = {
  createProcessingOrder,
};
