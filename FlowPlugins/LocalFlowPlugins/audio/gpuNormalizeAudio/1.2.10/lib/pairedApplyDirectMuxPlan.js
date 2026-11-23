"use strict";

function resolvePairedApplyDirectMuxPlan({
  args,
  directMuxStrategy,
  fallbackPlan,
  originalPlan,
  audioPlans,
}) {
  const directMuxEnabled = directMuxStrategy.requested
    && audioPlans.length === 2
    && audioPlans.every((plan) => plan.idx === fallbackPlan.idx || plan.idx === originalPlan.idx);
  if (directMuxStrategy.requested && !directMuxEnabled) {
    args.jobLog("GPU normalize paired direct mux requested but skipped: diagnostic currently requires exactly the paired original+stereo audio plans.");
  }
  const directMuxInputPlans = directMuxEnabled
    ? directMuxStrategy.originalOnly
      ? [originalPlan]
      : directMuxStrategy.fallbackFirst
        ? [fallbackPlan, originalPlan]
        : audioPlans
    : [];
  const encodedInputPlanIds = directMuxEnabled && directMuxStrategy.encodedFifoOriginal ? [originalPlan.idx] : [];
  const directMuxPlanEnabled = (plan) => directMuxEnabled && directMuxInputPlans.some((inputPlan) => inputPlan.idx === plan.idx);
  const fallbackDirectMux = directMuxPlanEnabled(fallbackPlan);
  const originalDirectMux = directMuxPlanEnabled(originalPlan);
  const directMuxFdWrites = directMuxEnabled && directMuxStrategy.orchestratorFifoFd ? {
    ...(fallbackDirectMux ? { fallback: { path: fallbackPlan.fifoOutput, token: "__loudnorm_fifo_fd_fallback__" } } : {}),
    ...(originalDirectMux ? { original: { path: originalPlan.fifoOutput, token: "__loudnorm_fifo_fd_original__" } } : {}),
  } : {};
  const directMuxPipeFds = directMuxEnabled && directMuxStrategy.osPipe ? {
    ...(fallbackDirectMux ? { fallback: { readToken: "__loudnorm_pipe_fd_fallback_read__", writeToken: "__loudnorm_pipe_fd_fallback_write__" } } : {}),
    ...(originalDirectMux ? { original: { readToken: "__loudnorm_pipe_fd_original_read__", writeToken: "__loudnorm_pipe_fd_original_write__" } } : {}),
  } : {};
  const directMuxRawInputPathFor = (plan) => {
    if (!directMuxStrategy.osPipe) return plan.fifoOutput;
    if (plan.idx === fallbackPlan.idx && directMuxPipeFds.fallback) return `pipe:${directMuxPipeFds.fallback.readToken}`;
    if (plan.idx === originalPlan.idx && directMuxPipeFds.original) return `pipe:${directMuxPipeFds.original.readToken}`;
    return plan.fifoOutput;
  };

  return {
    directMuxEnabled,
    directMuxFdWrites,
    directMuxInputPlans,
    directMuxPipeFds,
    directMuxPlanEnabled,
    directMuxRawInputPathFor,
    encodedInputPlanIds,
  };
}

module.exports = {
  resolvePairedApplyDirectMuxPlan,
};
