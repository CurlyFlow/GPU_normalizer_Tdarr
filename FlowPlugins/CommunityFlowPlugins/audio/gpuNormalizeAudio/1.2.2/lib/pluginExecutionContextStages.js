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

function createRuntimeCommandStage(context) {
  return createPluginRuntimeCommandContext(context);
}

function createStatsCoordinatorStage(context, runtimeContext) {
  return createPluginStatsCoordinatorContext({
    ...context,
    ...runtimeContext,
  });
}

function createProcessingStage(context, runtimeContext, statsContext) {
  return createPluginProcessingContext({
    ...context,
    ...runtimeContext,
    ...statsContext,
  });
}

module.exports = {
  createProcessingStage,
  createRuntimeCommandStage,
  createStatsCoordinatorStage,
};
