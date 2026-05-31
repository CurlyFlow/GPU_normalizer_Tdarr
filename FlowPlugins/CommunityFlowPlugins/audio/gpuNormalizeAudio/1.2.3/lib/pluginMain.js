"use strict";

const {
  runShell,
} = require("./shell");
const {
  runPluginPipeline,
} = require("./pluginPipeline");
const {
  createPluginExecutionContext,
} = require("./pluginExecutionContext");
const {
  createPluginMainSetup,
} = require("./pluginMainSetup");

async function runGpuNormalizePlugin(args, {
  details,
  pluginRoot,
}) {
  const pluginStartedAt = Date.now();
  const runtimeRoot = `${pluginRoot}/runtime`;
  const runtimeBin = `${runtimeRoot}/bin`;
  const runtimeCuda = `${runtimeRoot}/cuda`;

  const setup = createPluginMainSetup({
    args,
    runtimeBin,
    details,
  });
  if (setup.earlyResult) return setup.earlyResult;

  const {
    planSetup,
    preflight,
    runtimeConfig,
  } = setup;
  const {
    cancelBackgroundCpu,
    finalizeOutput,
    isPairedDirectMuxCompleted,
    processStreams,
    settleCpuLoudnormTasks,
  } = createPluginExecutionContext({
    args,
    pluginStartedAt,
    planSetup,
    preflight,
    runtimeConfig,
    runtimeCuda,
    runShell,
  });

  return await runPluginPipeline({
    args,
    processStreams,
    finalizeOutput,
    muxWork: planSetup.muxWork,
    isPairedDirectMuxCompleted,
    cancelBackgroundCpu,
    settleCpuLoudnormTasks,
    cleanupAll: planSetup.cleanupAll,
    runShell,
  });
}

module.exports = {
  runGpuNormalizePlugin,
};
