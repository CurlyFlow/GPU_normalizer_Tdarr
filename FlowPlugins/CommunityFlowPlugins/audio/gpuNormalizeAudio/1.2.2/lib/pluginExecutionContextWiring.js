"use strict";

const {
  createProcessingStage,
  createRuntimeCommandStage,
  createStatsCoordinatorStage,
} = require("./pluginExecutionContextStages");

function createPluginExecutionContexts(context) {
  const runtimeContext = createRuntimeCommandStage(context);
  const statsContext = createStatsCoordinatorStage(context, runtimeContext);
  const processingContext = createProcessingStage(context, runtimeContext, statsContext);

  return {
    processingContext,
    runtimeContext,
    statsContext,
  };
}

module.exports = {
  createPluginExecutionContexts,
};
