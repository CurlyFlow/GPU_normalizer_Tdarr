"use strict";

function createPlanSetupInput({ args, preflight, runtimeConfig }) {
  const { audioConfig, outputPathConfig } = runtimeConfig;
  return {
    args,
    audioStreams: preflight.audioStreams,
    debugLogging: preflight.debugLogging,
    audioBitrate: audioConfig.audioBitrate,
    base: outputPathConfig.base,
    container: outputPathConfig.container,
    durationSeconds: outputPathConfig.durationSeconds,
    ensureStereo: audioConfig.ensureStereo,
    fallbackToUndetectedAudio: audioConfig.fallbackToUndetectedAudio,
    gpuInputExt: audioConfig.gpuInputExt,
    gpuInputFormat: audioConfig.gpuInputFormat,
    gpuOutputExt: audioConfig.gpuOutputExt,
    gpuOutputFormat: audioConfig.gpuOutputFormat,
    normalizeOnlyLanguages: audioConfig.normalizeOnlyLanguages,
    removeOtherLanguages: audioConfig.removeOtherLanguages,
    runId: outputPathConfig.runId,
    sampleRate: audioConfig.sampleRate,
    stereoFallbackFirstOnly: audioConfig.stereoFallbackFirstOnly,
    stereoLanguageOrder: audioConfig.stereoLanguageOrder,
    tmpOutputFilePath: outputPathConfig.tmpOutputFilePath,
    workDir: outputPathConfig.workDir,
  };
}

function createPluginExecutionModel({
  args,
  pluginStartedAt,
  planSetup,
  preflight,
  runtimeConfig,
  runtimeCuda,
  runShell,
}) {
  return {
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
}

module.exports = {
  createPlanSetupInput,
  createPluginExecutionModel,
};
