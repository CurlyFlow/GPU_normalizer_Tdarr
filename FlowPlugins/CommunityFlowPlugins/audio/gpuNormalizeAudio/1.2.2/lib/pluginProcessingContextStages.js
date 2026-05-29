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

function createCommandBuilderStage(context) {
  return createPluginCommandBuilderContext(context);
}

function createProcessingCoordinatorsStage(context, commandBuilders) {
  return createPluginProcessingCoordinators({
    ...context,
    ...commandBuilders,
  });
}

function logProcessingDebugSummaryStage({
  args,
  audioPlans,
  debugLogging,
  logDebugPlanSummary,
  planLabelFor,
  processingPlans,
  requireGpuWorker,
  stereoFallbackSourceExact,
  useGpuSourcePort,
  useStreamingSourcePort,
  workerType,
}) {
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
}

module.exports = {
  createCommandBuilderStage,
  createProcessingCoordinatorsStage,
  logProcessingDebugSummaryStage,
};
