"use strict";

const { details } = require("./mediaPipelineDetails");
const { preparePipeline, finishPipeline } = require("./pipelineLifecycle");
const { recoverPublishedFile } = require("./publishedImportRecovery");

function createMediaPipelinePlugin(pluginRoot) {
  return { details, recoverPublishedFile, plugin: async (args) => {
    const context = { details, pluginRoot };
    if (args.inputs?.phase === "finish") return await finishPipeline(args, context);
    if (args.inputs?.phase === "prepare" || args.inputs?.phase === undefined) {
      return await preparePipeline(args, context);
    }
    throw new Error("Media Pipeline Helper requires phase prepare or finish");
  } };
}

module.exports = { createMediaPipelinePlugin };
