"use strict";

const {
  createPluginRuntimePlanContext,
} = require("./pluginRuntimePlanContext");
const {
  createRuntimeExecution,
} = require("./runtimeExecution");

function createRuntimeCommandContextInput(model) {
  const { core, planSetup, runtimeConfig } = model;
  const { audioConfig, diagnosticsConfig, featureConfig, outputPathConfig, runtimePathConfig } = runtimeConfig;
  return {
    args: core.args,
    base: outputPathConfig.base,
    defaultChunkMiB: audioConfig.defaultChunkMiB,
    diagnosticsConfig,
    durationSeconds: outputPathConfig.durationSeconds,
    forcedEncodeSampleRate: audioConfig.forcedEncodeSampleRate,
    featureConfig,
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
  } = createRuntimeExecution({
    args: context.args,
    base: context.base,
    planLabelFor: context.planLabelFor,
    runId: context.runId,
    runShell: context.runShell,
    workDir: context.workDir,
    diagnostics: context.diagnosticsConfig,
  });
  const {
    cpuLoudnormNice,
    gpuFirstPassAudit,
    gpuFirstPassMeasure,
    gpuFirstPassOriginalOnly,
    pairCpuLoudnormMeasure,
  } = context.featureConfig;
  const {
    loudnormFilter,
    loudnessSummary,
    canSkipOriginalAformat,
    ingressSampleRateFor,
    processingSampleRateFor,
    encodeSampleRateArgsFor,
    decodeAudioArgs,
    rawInputAudioArgs,
    applyChunkMiBFor,
    buildCpuLoudnormMeasure,
    buildPairedCpuLoudnormMeasure,
    buildGpuFirstPassInputMeasure,
    buildGpuFirstPassMeasure,
    buildRawSourcePortGpuPlan,
    buildStatsRuntimePlan,
    buildStreamingGpuPlan,
    buildPairedStreamingGpuPlan,
  } = createPluginRuntimePlanContext({
    args: context.args,
    cpuLoudnormNice,
    defaultChunkMiB: context.defaultChunkMiB,
    durationSeconds: context.durationSeconds,
    forcedEncodeSampleRate: context.forcedEncodeSampleRate,
    gpuPlanCoreCommand: context.gpuPlanCoreCommand,
    maxGain: context.maxGain,
    needsInlineStereoDownmix: context.needsInlineStereoDownmix,
    originalApplyChunkMiB: context.originalApplyChunkMiB,
    runtimeCuda: context.runtimeCuda,
    sampleRate: context.sampleRate,
    sourceChannelsFor: context.sourceChannelsFor,
    stereoFallbackApplyChunkMiB: context.stereoFallbackApplyChunkMiB,
    stereoFallbackChunkMiB: context.stereoFallbackChunkMiB,
    targetI: context.targetI,
    targetLra: context.targetLra,
    targetTp: context.targetTp,
    usesStereoFallbackSourcePath: context.usesStereoFallbackSourcePath,
  });

  return {
    applyChunkMiBFor,
    buildCpuLoudnormMeasure,
    buildGpuFirstPassInputMeasure,
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
    gpuFirstPassOriginalOnly,
    loudnessSummary,
    loudnormFilter,
    ingressSampleRateFor,
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
