"use strict";

const {
  runStreamParallelProcessing,
} = require("./streamParallelProcessor");
const {
  runSerialStreamProcessing,
} = require("./streamSerialProcessor");

async function runStreamProcessorRoute(streamExecutionContext) {
  if (streamExecutionContext.policy.useStreamParallelism) {
    return await runStreamParallelProcessing(streamExecutionContext);
  }
  return await runSerialStreamProcessing(streamExecutionContext);
}

module.exports = {
  runStreamProcessorRoute,
};
