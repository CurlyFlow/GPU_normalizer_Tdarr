"use strict";

const {
  createPlanSetupStage,
  createRuntimeConfigStage,
  initializePreflightStage,
} = require("./pluginMainSetupStages");

function createPluginMainSetup({
  args,
  details,
  runtimeBin,
}) {
  const preflight = initializePreflightStage({ args, details });
  if (preflight.earlyResult) return { earlyResult: preflight.earlyResult };

  const runtimeConfig = createRuntimeConfigStage({
    args,
    runtimeBin,
    preflight,
  });
  const planSetup = createPlanSetupStage({
    args,
    preflight,
    runtimeConfig,
  });
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
