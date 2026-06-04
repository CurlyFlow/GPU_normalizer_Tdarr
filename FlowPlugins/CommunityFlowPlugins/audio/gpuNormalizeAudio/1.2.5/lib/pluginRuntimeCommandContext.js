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
const {
  createRuntimeExecutionInput,
  createRuntimeFeatureInput,
  createRuntimePlanInput,
} = require("./pluginRuntimeCommandModel");

function createRuntimeCommandContextInput(model) {
  const { core, planSetup, runtimeConfig } = model;
  const { audioConfig, outputPathConfig, runtimePathConfig } = runtimeConfig;
  return {
    args: core.args,
    base: outputPathConfig.base,
    defaultChunkMiB: audioConfig.defaultChunkMiB,
    durationSeconds: outputPathConfig.durationSeconds,
    forcedEncodeSampleRate: audioConfig.forcedEncodeSampleRate,
    gpuPlanCoreCommand: runtimePathConfig.gpuPlanCoreCommand,
    maxGain: audioConfig.maxGain,
    needsInlineStereoDownmix: planSetup.needsInlineStereoDownmix,
    originalApplyChunkMiB: audioConfig.originalApplyChunkMiB,
    planLabelFor: planSetup.planLabelFor,
    runId: outputPathConfig.runId,
    runShell: core.runShell,
    runtimeCuda: core.runtimeCuda,
    sampleRate: audioConfig.sampleRate,
    sourceChannelsFor: planSetup.sourceChannelsFor,
    sourceCorePath: runtimePathConfig.sourceCorePath,
    stereoFallbackApplyChunkMiB: audioConfig.stereoFallbackApplyChunkMiB,
    stereoFallbackChunkMiB: audioConfig.stereoFallbackChunkMiB,
    targetI: audioConfig.targetI,
    targetLra: audioConfig.targetLra,
    targetTp: audioConfig.targetTp,
    useGpuSourcePort: runtimePathConfig.useGpuSourcePort,
    usesStereoFallbackSourcePath: planSetup.usesStereoFallbackSourcePath,
    useStreamingSourcePort: audioConfig.useStreamingSourcePort,
    workDir: outputPathConfig.workDir,
  };
}

function createPluginRuntimeCommandContext(model) {
  const context = createRuntimeCommandContextInput(model);
  const {
    runChecked,
    wrapRuntimeProfile,
  } = createRuntimeExecution(createRuntimeExecutionInput(context));
  const {
    cpuLoudnormNice,
    gpuFirstPassAudit,
    gpuFirstPassMeasure,
    pairCpuLoudnormMeasure,
  } = createPluginRuntimeFeatureConfig(createRuntimeFeatureInput(context));
  const {
    loudnormFilter,
    loudnessSummary,
    canSkipOriginalAformat,
    processingSampleRateFor,
    encodeSampleRateArgsFor,
    decodeAudioArgs,
    rawInputAudioArgs,
    applyChunkMiBFor,
    buildCpuLoudnormMeasure,
    buildPairedCpuLoudnormMeasure,
    buildGpuFirstPassMeasure,
    buildRawSourcePortGpuPlan,
    buildStatsRuntimePlan,
    buildStreamingGpuPlan,
    buildPairedStreamingGpuPlan,
  } = createPluginRuntimePlanContext(createRuntimePlanInput(context, { cpuLoudnormNice }));

  return {
    applyChunkMiBFor,
    buildCpuLoudnormMeasure,
    buildGpuFirstPassMeasure,
    buildPairedCpuLoudnormMeasure,
    buildPairedStreamingGpuPlan,
    buildRawSourcePortGpuPlan,
    buildStatsRuntimePlan,
    buildStreamingGpuPlan,
    canSkipOriginalAformat,
    decodeAudioArgs,
    encodeSampleRateArgsFor,
    gpuFirstPassAudit,
    gpuFirstPassMeasure,
    loudnessSummary,
    loudnormFilter,
    pairCpuLoudnormMeasure,
    processingSampleRateFor,
    rawInputAudioArgs,
    runChecked,
    wrapRuntimeProfile,
  };
}

module.exports = {
  createPluginRuntimeCommandContext,
};
