"use strict";

const {
  createPluginRuntimeCommandContext,
} = require("./pluginRuntimeCommandContext");
const {
  createPluginStatsCoordinatorContext,
} = require("./pluginStatsCoordinatorContext");
const {
  createPluginProcessingContext,
} = require("./pluginProcessingContext");
const {
  createPluginExecutionModel,
} = require("./pluginContextModel");

function createPluginExecutionContext(setupContext) {
  const model = createPluginExecutionModel(setupContext);
  const runtimeContext = createPluginRuntimeCommandContext(model);
  const statsContext = createPluginStatsCoordinatorContext(model, runtimeContext);
  const processingContext = createPluginProcessingContext(model, runtimeContext, statsContext);

  return {
    cancelBackgroundCpu: statsContext.cancelBackgroundCpu,
    finalizeOutput: processingContext.finalizeOutput,
    isPairedDirectMuxCompleted: processingContext.isPairedDirectMuxCompleted,
    muxWork: model.planSetup.muxWork,
    processStreams: processingContext.processStreams,
    settleCpuLoudnormTasks: statsContext.settleCpuLoudnormTasks,
  };
}

module.exports = {
  createPluginExecutionContext,
};
