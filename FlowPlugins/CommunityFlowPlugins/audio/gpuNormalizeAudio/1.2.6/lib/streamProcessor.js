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
const {
  intNum,
} = require("./common");
const {
  sleep,
} = require("./shell");

function cpuLoudnormHeadstartMs() {
  return Math.max(0, Math.min(60000, intNum(process.env.LOUDNORM_GPU_CPU_LOUDNORM_HEADSTART_MS, 0)));
}

function createStreamProcessor(streamPipelineDeps) {
  const { execution, pairedApply, plans, prefetch, progress, stats } = streamPipelineDeps;
  const {
    streamPlanCapabilities,
    streamParallelism,
    useParallelSerialStreams,
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
    const prefetchedCpuTasks = prefetchInitialCpuLoudnorm({
      earlyCpuPrefetch: prefetch.earlyCpuPrefetch,
      earlyCpuPrefetchLimit: prefetch.earlyCpuPrefetchLimit,
      pairStereoFallbackApply: pairedApply.pairStereoFallbackApply,
      prefetchCpuLoudnormFrom: prefetch.prefetchCpuLoudnormFrom,
    });
    const headstartMs = prefetchedCpuTasks > 0 ? cpuLoudnormHeadstartMs() : 0;
    if (headstartMs > 0) {
      execution.args.jobLog(`GPU normalize waiting ${headstartMs}ms CPU loudnorm headstart before first GPU stream starts`);
      await sleep(headstartMs);
    }
    progress.updateProgress(0, true);
    return await runStreamProcessorRoute(createStreamExecutionContext(streamPipelineDeps, {
      streamPlanCapabilities,
      streamParallelism,
      useParallelSerialStreams,
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
