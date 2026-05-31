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
  createProcessingInput,
  createPluginExecutionModel,
  createRuntimeCommandInput,
  createStatsCoordinatorInput,
} = require("./pluginContextModel");

function createPluginExecutionContext(setupContext) {
  const model = createPluginExecutionModel(setupContext);
  const runtimeContext = createPluginRuntimeCommandContext(createRuntimeCommandInput(model));
  const statsContext = createPluginStatsCoordinatorContext(createStatsCoordinatorInput(model, runtimeContext));
  const processingContext = createPluginProcessingContext(createProcessingInput(model, runtimeContext, statsContext));

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
