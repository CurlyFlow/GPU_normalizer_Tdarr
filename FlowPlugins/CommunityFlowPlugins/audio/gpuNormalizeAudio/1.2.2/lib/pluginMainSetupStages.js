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

function initializePreflightStage({ args, details }) {
  return initializePluginRun({ args, details });
}

function createRuntimeConfigStage({
  args,
  runtimeBin,
  preflight,
}) {
  return createPluginRuntimeConfig({
    args,
    runtimeBin,
    getContainer: preflight.getContainer,
    getFileName: preflight.getFileName,
    getPluginWorkDir: preflight.getPluginWorkDir,
  });
}

function createPlanSetupStage({
  args,
  preflight,
  runtimeConfig,
}) {
  return createPluginPlanSetup({
    args,
    audioStreams: preflight.audioStreams,
    stereoLanguageOrder: runtimeConfig.stereoLanguageOrder,
    normalizeOnlyLanguages: runtimeConfig.normalizeOnlyLanguages,
    removeOtherLanguages: runtimeConfig.removeOtherLanguages,
    ensureStereo: runtimeConfig.ensureStereo,
    stereoFallbackFirstOnly: runtimeConfig.stereoFallbackFirstOnly,
    sampleRate: runtimeConfig.sampleRate,
    durationSeconds: runtimeConfig.durationSeconds,
    workDir: runtimeConfig.workDir,
    base: runtimeConfig.base,
    runId: runtimeConfig.runId,
    gpuInputExt: runtimeConfig.gpuInputExt,
    gpuInputFormat: runtimeConfig.gpuInputFormat,
    gpuOutputExt: runtimeConfig.gpuOutputExt,
    gpuOutputFormat: runtimeConfig.gpuOutputFormat,
    tmpOutputFilePath: runtimeConfig.tmpOutputFilePath,
    audioBitrate: runtimeConfig.audioBitrate,
    debugLogging: preflight.debugLogging,
    container: runtimeConfig.container,
  });
}

module.exports = {
  createPlanSetupStage,
  createRuntimeConfigStage,
  initializePreflightStage,
};
