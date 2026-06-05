"use strict";

const {
  envFlag,
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
  const useParallelSerialStreams = useGpuSourcePort
    && useStreamingSourcePort
    && !gpuFirstPassMeasure
    && processingPlans.length > 1
    && streamParallelism > 1
    && envFlag("LOUDNORM_GPU_PARALLEL_SERIAL_STREAMS")
    && streamPlanCapabilities.blockedParallelPlans.every((capability) => !capability.pairedApply);

  return {
    streamPlanCapabilities,
    streamParallelism,
    useParallelSerialStreams,
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
    return 0;
  }
  const prefetchFirstPlan = !pairStereoFallbackApply && envFlag("LOUDNORM_GPU_CPU_LOUDNORM_PREFETCH_FIRST");
  const prefetchStart = (pairStereoFallbackApply || prefetchFirstPlan) ? 0 : 1;
  const prefetchLimit = pairStereoFallbackApply
    ? Math.max(earlyCpuPrefetchLimit, 2)
    : earlyCpuPrefetchLimit + (prefetchFirstPlan ? 1 : 0);
  return prefetchCpuLoudnormFrom(prefetchStart, prefetchLimit, "before first GPU stream starts") || 0;
}

module.exports = {
  createStreamProcessorPolicy,
  prefetchInitialCpuLoudnorm,
};
