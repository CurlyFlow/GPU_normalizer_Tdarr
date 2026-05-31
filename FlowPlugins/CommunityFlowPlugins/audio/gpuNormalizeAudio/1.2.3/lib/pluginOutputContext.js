"use strict";

const {
  createOutputFinalizer,
} = require("./outputFinalizer");

function createPluginOutputContext({
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
  removedAudioPlans,
  updateProgress,
  runChecked,
  cancelBackgroundCpu,
  settleCpuLoudnormTasks,
}) {
  return createOutputFinalizer({
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
    removedAudioPlans,
    updateProgress,
    runChecked,
    cancelBackgroundCpu,
    settleCpuLoudnormTasks,
  });
}

module.exports = {
  createPluginOutputContext,
};
