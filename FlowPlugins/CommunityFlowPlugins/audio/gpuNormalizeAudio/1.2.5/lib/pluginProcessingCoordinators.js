"use strict";

const {
  createPluginPairedApplyContext,
} = require("./pluginPairedApplyContext");
const {
  createPluginOutputContext,
} = require("./pluginOutputContext");
const {
  createPluginStreamContext,
} = require("./pluginStreamContext");

function createPluginProcessingCoordinators(context) {
  const pairedContext = createPluginPairedApplyContext(context);
  const outputContext = createPluginOutputContext(context);
  const streamContext = createPluginStreamContext({
    ...context,
    ...pairedContext,
    copyOriginalPackage: outputContext.copyOriginalPackage,
  });

  return {
    finalizeOutput: outputContext.finalizeOutput,
    isPairedDirectMuxCompleted: pairedContext.isPairedDirectMuxCompleted,
    processStreams: streamContext.processStreams,
  };
}

module.exports = {
  createPluginProcessingCoordinators,
};
