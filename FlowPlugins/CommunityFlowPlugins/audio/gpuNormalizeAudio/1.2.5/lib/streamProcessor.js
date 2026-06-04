"use strict";

const {
  createStreamProcessorPolicy,
  prefetchInitialCpuLoudnorm,
} = require("./streamProcessorPolicy");
const {
  runStreamProcessorRoute,
} = require("./streamProcessorRoutes");
const {
  createStreamExecutionContext,
} = require("./streamPipelineDeps");

function createStreamProcessor(streamPipelineDeps) {
  const { execution, pairedApply, plans, prefetch, progress, stats } = streamPipelineDeps;
  const {
    streamPlanCapabilities,
    streamParallelism,
    useStreamParallelism,
  } = createStreamProcessorPolicy({
    useGpuSourcePort: execution.useGpuSourcePort,
    useStreamingSourcePort: execution.useStreamingSourcePort,
    gpuFirstPassMeasure: execution.gpuFirstPassMeasure,
    processingPlans: plans.processingPlans,
    canSplitStatsPlan: stats.canSplitStatsPlan,
    pairedFallbackApplyPartner: pairedApply.pairedFallbackApplyPartner,
  });

  const processStreams = async () => {
    prefetchInitialCpuLoudnorm({
      earlyCpuPrefetch: prefetch.earlyCpuPrefetch,
      earlyCpuPrefetchLimit: prefetch.earlyCpuPrefetchLimit,
      pairStereoFallbackApply: pairedApply.pairStereoFallbackApply,
      prefetchCpuLoudnormFrom: prefetch.prefetchCpuLoudnormFrom,
    });
    progress.updateProgress(0, true);
    return await runStreamProcessorRoute(createStreamExecutionContext(streamPipelineDeps, {
      streamPlanCapabilities,
      streamParallelism,
      useStreamParallelism,
    }));
  };

  return {
    processStreams,
  };
}

module.exports = {
  createStreamProcessor,
};
