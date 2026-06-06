"use strict";

const {
  ffmpegProgressFraction,
  logProfileStage,
} = require("./common");
const {
  publishOutputPackage,
} = require("./outputPublish");

function createOutputFinalizer({
  args,
  pluginStartedAt,
  durationSeconds,
  totalWork,
  tmpOutputFilePath,
  outputFilePath,
  copyOriginal,
  mux,
  cleanupAll,
  audioPlans,
  skippedAudioPlans,
  removedAudioPlans = [],
  updateProgress,
  runChecked,
  cancelBackgroundCpu,
  settleCpuLoudnormTasks,
}) {
  const copyOriginalPackage = async (reason, progressBase) => {
    cancelBackgroundCpu();
    await settleCpuLoudnormTasks();
    args.jobLog(`GPU Normalize Audio result: ${reason}`);
    const copyRes = await runChecked(copyOriginal, {
      label: "copy original package",
      parseLine: (line) => {
        const fraction = ffmpegProgressFraction(line, durationSeconds);
        if (fraction !== null) updateProgress(progressBase + (totalWork - progressBase) * fraction);
      },
    });
    logProfileStage(args, { scope: "plugin", name: "copy_original", wall_sec: copyRes.wallSec });
    return await publishOutputPackage({
      args,
      pluginStartedAt,
      tmpOutputFilePath,
      outputFilePath,
      cleanupAll,
      publishLabel: "publish copied package",
      resultMessage: removedAudioPlans.length > 0
        ? `GPU Normalize Audio result: original selected audio copied and ${removedAudioPlans.length} other audio stream(s) removed.`
        : "GPU Normalize Audio result: original package copied unchanged.",
      runChecked,
      verifyLabel: "verify copied package",
    });
  };

  const finalizeOutput = async ({ completedWork, muxWork, directMuxCompleted }) => {
    if (directMuxCompleted) {
      logProfileStage(args, { scope: "plugin", name: "final_mux", wall_sec: 0, direct_paired: 1 });
    } else {
      const muxRes = await runChecked(mux, {
        label: "mux normalized audio streams",
        parseLine: (line) => {
          const fraction = ffmpegProgressFraction(line, durationSeconds);
          if (fraction !== null) updateProgress(completedWork + muxWork * fraction);
        },
      });
      logProfileStage(args, { scope: "plugin", name: "final_mux", wall_sec: muxRes.wallSec });
    }
    return await publishOutputPackage({
      args,
      pluginStartedAt,
      tmpOutputFilePath,
      outputFilePath,
      cleanupAll,
      resultMessage: `GPU Normalize Audio result: output contains ${audioPlans.length} normalized/generated audio stream(s), ${skippedAudioPlans.length} skipped audio stream(s), and removed ${removedAudioPlans.length} audio stream(s).`,
      runChecked,
    });
  };

  return {
    copyOriginalPackage,
    finalizeOutput,
  };
}

module.exports = {
  createOutputFinalizer,
};
