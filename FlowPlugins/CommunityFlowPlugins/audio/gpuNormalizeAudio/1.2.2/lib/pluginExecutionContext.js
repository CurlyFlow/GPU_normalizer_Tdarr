"use strict";

const {
  createPluginExecutionContexts,
} = require("./pluginExecutionContextWiring");

function createPluginExecutionContext(context) {
  const {
    muxWork,
  } = context;
  const {
    processingContext,
    statsContext,
  } = createPluginExecutionContexts(context);

  return {
    cancelBackgroundCpu: statsContext.cancelBackgroundCpu,
    finalizeOutput: processingContext.finalizeOutput,
    isPairedDirectMuxCompleted: processingContext.isPairedDirectMuxCompleted,
    muxWork,
    processStreams: processingContext.processStreams,
    settleCpuLoudnormTasks: statsContext.settleCpuLoudnormTasks,
  };
}

module.exports = {
  createPluginExecutionContext,
};
