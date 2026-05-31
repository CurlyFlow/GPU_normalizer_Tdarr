"use strict";

const {
  acquirePipelineConcurrencyStage,
  cleanupFailedPipelineStage,
  runStreamsAndFinalizeStage,
} = require("./pluginPipelineStages");

async function runPluginPipeline({
  args,
  processStreams,
  finalizeOutput,
  muxWork,
  isPairedDirectMuxCompleted,
  cancelBackgroundCpu,
  settleCpuLoudnormTasks,
  cleanupAll,
  runShell,
}) {
  const releaseConcurrencyLock = await acquirePipelineConcurrencyStage({ args });
  try {
    return await runStreamsAndFinalizeStage({
      processStreams,
      finalizeOutput,
      muxWork,
      isPairedDirectMuxCompleted,
    });
  } catch (err) {
    await cleanupFailedPipelineStage({
      args,
      cancelBackgroundCpu,
      settleCpuLoudnormTasks,
      cleanupAll,
      runShell,
    });
    throw err;
  } finally {
    releaseConcurrencyLock();
  }
}

module.exports = {
  runPluginPipeline,
};
