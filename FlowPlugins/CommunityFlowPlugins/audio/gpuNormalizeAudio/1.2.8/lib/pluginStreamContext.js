"use strict";

const {
  createStreamProcessor,
} = require("./streamProcessor");
const {
  createStreamPipelineDeps,
} = require("./streamPipelineDeps");

function createPluginStreamContext(context) {
  return createStreamProcessor(createStreamPipelineDeps(context));
}

module.exports = {
  createPluginStreamContext,
};
