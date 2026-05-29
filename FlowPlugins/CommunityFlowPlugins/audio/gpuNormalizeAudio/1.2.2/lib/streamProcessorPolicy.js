"use strict";

const {
  intNum,
} = require("./common");

function createStreamProcessorPolicy({
  useGpuSourcePort,
  useStreamingSourcePort,
  gpuFirstPassMeasure,
  processingPlans,
}) {
  const streamParallelismDefault = 1;
  const streamParallelism = Math.max(1, intNum(process.env.LOUDNORM_GPU_STREAM_PARALLELISM, streamParallelismDefault));
  const useStreamParallelism = useGpuSourcePort && useStreamingSourcePort && !gpuFirstPassMeasure && processingPlans.length > 1 && streamParallelism > 1;

  return {
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
