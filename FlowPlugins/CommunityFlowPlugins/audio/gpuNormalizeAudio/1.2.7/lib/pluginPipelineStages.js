"use strict";

const {
  logProfileStage,
} = require("./common");
const {
  acquireConcurrencyLock,
} = require("./concurrencyLock");

async function acquirePipelineConcurrencyStage({ args }) {
  return acquireConcurrencyLock(args, args.inputs.lockFile, args.inputs.maxConcurrentJobs);
}

async function runStreamsAndFinalizeStage({
  processStreams,
  finalizeOutput,
  muxWork,
  isPairedDirectMuxCompleted,
}) {
  const streamResult = await processStreams();
  if (streamResult.outputResult) return streamResult.outputResult;
  return await finalizeOutput({
    completedWork: streamResult.completedWork,
    muxWork,
    directMuxCompleted: isPairedDirectMuxCompleted(),
  });
}

async function cleanupFailedPipelineStage({
  args,
  cancelBackgroundCpu,
  settleCpuLoudnormTasks,
  cleanupAll,
  runShell,
}) {
  cancelBackgroundCpu();
  await settleCpuLoudnormTasks();
  try {
    const cleanupFailedRes = await runShell(cleanupAll, { args, label: "cleanup failed GPU normalize outputs" });
    logProfileStage(args, { scope: "plugin", name: "cleanup_failed", wall_sec: cleanupFailedRes.wallSec, exit_code: cleanupFailedRes.code });
  } catch (cleanupErr) {
    args.jobLog(`GPU normalize cleanup after failure failed: ${cleanupErr.message}`);
  }
}

module.exports = {
  acquirePipelineConcurrencyStage,
  cleanupFailedPipelineStage,
  runStreamsAndFinalizeStage,
};
