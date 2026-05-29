"use strict";

const {
  createAudioConfigStage,
  createOutputPathConfigStage,
  createRuntimePathConfigStage,
} = require("./pluginRuntimeConfigStages");

function createPluginRuntimeConfig({
  args,
  runtimeBin,
  getContainer,
  getFileName,
  getPluginWorkDir,
}) {
  const {
    gpuApplyPath,
    gpuPlanCoreCommand,
    pythonPath,
    sourceCorePath,
    useGpuSourcePort,
  } = createRuntimePathConfigStage({ args, runtimeBin });
  const {
    audioBitrate,
    defaultChunkMiB,
    encodeThreadArgs,
    ensureStereo,
    forcedEncodeSampleRate,
    gpuInputExt,
    gpuInputFormat,
    gpuOutputExt,
    gpuOutputFormat,
    maxGain,
    normalizeOnlyLanguages,
    originalApplyChunkMiB,
    removeOtherLanguages,
    sampleRate,
    stereoFallbackApplyChunkMiB,
    stereoFallbackChunkMiB,
    stereoFallbackFirstOnly,
    stereoLanguageOrder,
    targetI,
    targetLra,
    targetTp,
    useStreamingSourcePort,
  } = createAudioConfigStage({
    args,
    runtimePathConfig: { useGpuSourcePort },
  });
  const {
    base,
    container,
    durationSeconds,
    outputFilePath,
    runId,
    tmpOutputFilePath,
    workDir,
  } = createOutputPathConfigStage({
    args,
    getContainer,
    getFileName,
    getPluginWorkDir,
  });

  return {
    audioBitrate,
    base,
    container,
    defaultChunkMiB,
    durationSeconds,
    encodeThreadArgs,
    ensureStereo,
    forcedEncodeSampleRate,
    gpuApplyPath,
    gpuInputExt,
    gpuInputFormat,
    gpuOutputExt,
    gpuOutputFormat,
    gpuPlanCoreCommand,
    maxGain,
    normalizeOnlyLanguages,
    originalApplyChunkMiB,
    outputFilePath,
    pythonPath,
    removeOtherLanguages,
    runId,
    sampleRate,
    sourceCorePath,
    stereoFallbackApplyChunkMiB,
    stereoFallbackChunkMiB,
    stereoFallbackFirstOnly,
    stereoLanguageOrder,
    targetI,
    targetLra,
    targetTp,
    tmpOutputFilePath,
    useGpuSourcePort,
    useStreamingSourcePort,
    workDir,
  };
}

module.exports = {
  createPluginRuntimeConfig,
};
