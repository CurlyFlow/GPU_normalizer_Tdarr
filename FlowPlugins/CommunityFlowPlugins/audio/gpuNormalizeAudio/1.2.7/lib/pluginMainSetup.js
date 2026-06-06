"use strict";

const {
  createPluginRuntimeConfig,
} = require("./pluginConfig");
const {
  initializePluginRun,
} = require("./pluginPreflight");
const {
  createPluginPlanSetup,
} = require("./pluginPlanSetup");
const {
  createPlanSetupInput,
} = require("./pluginContextModel");

function createPluginMainSetup({
  args,
  details,
  runtimeBin,
}) {
  const preflight = initializePluginRun({ args, details });
  if (preflight.earlyResult) return { earlyResult: preflight.earlyResult };

  const runtimeConfig = createPluginRuntimeConfig({
    args,
    runtimeBin,
    getContainer: preflight.getContainer,
    getFileName: preflight.getFileName,
    getPluginWorkDir: preflight.getPluginWorkDir,
  });
  const planSetup = createPluginPlanSetup(createPlanSetupInput({ args, preflight, runtimeConfig }));
  if (planSetup.earlyResult) return { earlyResult: planSetup.earlyResult };

  return {
    planSetup,
    preflight,
    runtimeConfig,
  };
}

module.exports = {
  createPluginMainSetup,
};
