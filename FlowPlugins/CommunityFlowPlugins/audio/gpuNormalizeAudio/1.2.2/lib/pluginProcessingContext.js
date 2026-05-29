"use strict";

const {
  createCommandBuilderStage,
  createProcessingCoordinatorsStage,
  logProcessingDebugSummaryStage,
} = require("./pluginProcessingContextStages");

function createPluginProcessingContext(context) {
  const {
    args,
    audioPlans,
    debugLogging,
    logDebugPlanSummary,
    muxWork,
    planLabelFor,
    processingPlans,
    requireGpuWorker,
    stereoFallbackSourceExact,
    useGpuSourcePort,
    useStreamingSourcePort,
    workerType,
  } = context;
  const commandBuilders = createCommandBuilderStage(context);
  const {
    finalizeOutput,
    isPairedDirectMuxCompleted,
    processStreams,
  } = createProcessingCoordinatorsStage(context, commandBuilders);

  logProcessingDebugSummaryStage({
    args,
    debugLogging,
    useGpuSourcePort,
    workerType,
    requireGpuWorker,
    logDebugPlanSummary,
    processingPlans,
    audioPlans,
    planLabelFor,
    stereoFallbackSourceExact,
    useStreamingSourcePort,
  });

  return {
    finalizeOutput,
    isPairedDirectMuxCompleted,
    muxWork,
    processStreams,
  };
}

module.exports = {
  createPluginProcessingContext,
};
