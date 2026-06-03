"use strict";

const {
  intNum,
} = require("./common");
const {
  createStreamPlanCapabilities,
} = require("./streamPlanCapabilities");

function createStreamProcessorPolicy({
  useGpuSourcePort,
  useStreamingSourcePort,
  gpuFirstPassMeasure,
  processingPlans,
  canSplitStatsPlan,
  pairedFallbackApplyPartner,
}) {
  const streamParallelismDefault = 1;
  const streamParallelism = Math.max(1, intNum(process.env.LOUDNORM_GPU_STREAM_PARALLELISM, streamParallelismDefault));
  const streamPlanCapabilities = createStreamPlanCapabilities({
    processingPlans,
    canSplitStatsPlan,
    pairedFallbackApplyPartner,
  });
  const useStreamParallelism = useGpuSourcePort
    && useStreamingSourcePort
    && !gpuFirstPassMeasure
    && processingPlans.length > 1
    && streamParallelism > 1
    && streamPlanCapabilities.supportsParallelStream;

  return {
    streamPlanCapabilities,
    streamParallelism,
    useStreamParallelism,
  };
}

function prefetchInitialCpuLoudnorm({
  earlyCpuPrefetch,
  earlyCpuPrefetchLimit,
  pairStereoFallbackApply,
  prefetchCpuLoudnormFrom,
}) {
  if (!earlyCpuPrefetch) {
    return;
  }
  const prefetchStart = pairStereoFallbackApply ? 0 : 1;
  const prefetchLimit = pairStereoFallbackApply ? Math.max(earlyCpuPrefetchLimit, 2) : earlyCpuPrefetchLimit;
  prefetchCpuLoudnormFrom(prefetchStart, prefetchLimit, "before first GPU stream starts");
}

module.exports = {
  createStreamProcessorPolicy,
  prefetchInitialCpuLoudnorm,
};
