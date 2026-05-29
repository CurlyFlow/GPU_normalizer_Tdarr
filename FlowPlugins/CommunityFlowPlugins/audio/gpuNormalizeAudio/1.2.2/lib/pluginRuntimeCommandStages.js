"use strict";

const {
  createPluginRuntimeFeatureConfig,
} = require("./pluginRuntimeFeatureConfig");
const {
  createPluginRuntimePlanContext,
} = require("./pluginRuntimePlanContext");
const {
  createRuntimeExecution,
} = require("./runtimeExecution");

function createRuntimeExecutionStage({
  args,
  base,
  runId,
  workDir,
  runShell,
  planLabelFor,
}) {
  return createRuntimeExecution({
    args,
    base,
    runId,
    workDir,
    runShell,
    planLabelFor,
  });
}

function createRuntimeFeatureStage({
  args,
  useGpuSourcePort,
  useStreamingSourcePort,
}) {
  return createPluginRuntimeFeatureConfig({
    args,
    useGpuSourcePort,
    useStreamingSourcePort,
  });
}

function createRuntimePlanStage({
  args,
  featureContext,
  sampleRate,
  forcedEncodeSampleRate,
  targetI,
  targetLra,
  targetTp,
  defaultChunkMiB,
  stereoFallbackChunkMiB,
  stereoFallbackApplyChunkMiB,
  originalApplyChunkMiB,
  sourceChannelsFor,
  needsInlineStereoDownmix,
  gpuPlanCoreCommand,
  maxGain,
  runtimeCuda,
  sourceCorePath,
  durationSeconds,
  usesStereoFallbackSourcePath,
}) {
  return createPluginRuntimePlanContext({
    args,
    sampleRate,
    forcedEncodeSampleRate,
    targetI,
    targetLra,
    targetTp,
    defaultChunkMiB,
    stereoFallbackChunkMiB,
    stereoFallbackApplyChunkMiB,
    originalApplyChunkMiB,
    sourceChannelsFor,
    needsInlineStereoDownmix,
    cpuLoudnormNice: featureContext.cpuLoudnormNice,
    gpuPlanCoreCommand,
    maxGain,
    runtimeCuda,
    sourceCorePath,
    durationSeconds,
    usesStereoFallbackSourcePath,
  });
}

module.exports = {
  createRuntimeExecutionStage,
  createRuntimeFeatureStage,
  createRuntimePlanStage,
};
