"use strict";

function createRuntimeExecutionInput(context) {
  const { args, base, planLabelFor, runId, runShell, workDir } = context;
  return { args, base, planLabelFor, runId, runShell, workDir };
}

function createRuntimeFeatureInput(context) {
  const { args, durationSeconds, useGpuSourcePort, useStreamingSourcePort } = context;
  return { args, durationSeconds, useGpuSourcePort, useStreamingSourcePort };
}

function createRuntimePlanInput(context, featureConfig) {
  const {
    args,
    defaultChunkMiB,
    durationSeconds,
    forcedEncodeSampleRate,
    gpuPlanCoreCommand,
    maxGain,
    needsInlineStereoDownmix,
    originalApplyChunkMiB,
    runtimeCuda,
    sampleRate,
    sourceChannelsFor,
    sourceCorePath,
    stereoFallbackApplyChunkMiB,
    stereoFallbackChunkMiB,
    targetI,
    targetLra,
    targetTp,
    usesStereoFallbackSourcePath,
  } = context;
  return {
    args,
    cpuLoudnormNice: featureConfig.cpuLoudnormNice,
    defaultChunkMiB,
    durationSeconds,
    forcedEncodeSampleRate,
    gpuPlanCoreCommand,
    maxGain,
    needsInlineStereoDownmix,
    originalApplyChunkMiB,
    runtimeCuda,
    sampleRate,
    sourceChannelsFor,
    sourceCorePath,
    stereoFallbackApplyChunkMiB,
    stereoFallbackChunkMiB,
    targetI,
    targetLra,
    targetTp,
    usesStereoFallbackSourcePath,
  };
}

module.exports = {
  createRuntimeExecutionInput,
  createRuntimeFeatureInput,
  createRuntimePlanInput,
};
