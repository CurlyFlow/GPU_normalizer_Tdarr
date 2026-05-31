"use strict";

const {
  createParallelStreamContext,
  createSerialPlanRunContext,
} = require("./streamPipelineDeps");

const {
  runStreamParallelProcessing,
} = require("./streamParallelProcessor");
const {
  runSerialStreamProcessing,
} = require("./streamSerialProcessor");

async function runStreamProcessorRoute(streamExecutionContext) {
  if (streamExecutionContext.policy.useStreamParallelism) {
    return await runStreamParallelProcessing(createParallelStreamContext(streamExecutionContext));
  }
  return await runSerialStreamProcessing(streamExecutionContext, createSerialPlanRunContext);
}

module.exports = {
  runStreamProcessorRoute,
};
