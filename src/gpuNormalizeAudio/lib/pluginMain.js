"use strict";

const {
  runShell,
} = require("./shell");
const {
  logProfileStage,
} = require("./common");
const {
  acquireConcurrencyLock,
} = require("./concurrencyLock");
const {
  createPluginRuntimeCommandContext,
} = require("./pluginRuntimeCommandContext");
const {
  createPluginStatsCoordinatorContext,
} = require("./pluginStatsCoordinatorContext");
const {
  createPluginProcessingContext,
} = require("./pluginProcessingContext");
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
  const pluginRunContext = {
    core: {
      args,
      pluginStartedAt,
      runtimeCuda,
      runShell,
    },
    planSetup,
    preflight,
    runtimeConfig,
  };
  const runtimeContext = createPluginRuntimeCommandContext(pluginRunContext);
  const statsContext = createPluginStatsCoordinatorContext(pluginRunContext, runtimeContext);
  const processingContext = createPluginProcessingContext(pluginRunContext, runtimeContext, statsContext);
  const {
    finalizeOutput,
    isPairedDirectMuxCompleted,
    processStreams,
  } = processingContext;

  const releaseConcurrencyLock = await acquireConcurrencyLock(args, args.inputs.lockFile, args.inputs.maxConcurrentJobs);
  try {
    const streamResult = await processStreams();
    if (streamResult.outputResult) return streamResult.outputResult;
    return await finalizeOutput({
      completedWork: streamResult.completedWork,
      muxWork: planSetup.muxWork,
      directMuxCompleted: streamResult.directMuxCompleted || isPairedDirectMuxCompleted(),
    });
  } catch (err) {
    statsContext.cancelBackgroundCpu();
    await statsContext.settleCpuLoudnormTasks();
    if (err.preserveMediaEvidence === true) {
      args.jobLog("Original-relative verification held; candidate and evidence retained for diagnosis, not publication.");
    } else try {
      const cleanupFailedRes = await runShell(planSetup.cleanupAll, { args, label: "cleanup failed GPU normalize outputs" });
      logProfileStage(args, { scope: "plugin", name: "cleanup_failed", wall_sec: cleanupFailedRes.wallSec, exit_code: cleanupFailedRes.code });
    } catch (cleanupErr) {
      args.jobLog(`GPU normalize cleanup after failure failed: ${cleanupErr.message}`);
    }
    throw err;
  } finally {
    releaseConcurrencyLock();
  }
}

module.exports = {
  runGpuNormalizePlugin,
};
