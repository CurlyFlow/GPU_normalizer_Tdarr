"use strict";

const {
  logPluginDebugSummary,
} = require("./pluginDebugLogging");
const {
  createPluginCommandBuilderContext,
} = require("./pluginCommandBuilderContext");
const {
  createPluginProcessingCoordinators,
} = require("./pluginProcessingCoordinators");

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
  const commandBuilders = createPluginCommandBuilderContext(context);
  const {
    finalizeOutput,
    isPairedDirectMuxCompleted,
    processStreams,
  } = createPluginProcessingCoordinators({
    ...context,
    ...commandBuilders,
  });

  logPluginDebugSummary({
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
