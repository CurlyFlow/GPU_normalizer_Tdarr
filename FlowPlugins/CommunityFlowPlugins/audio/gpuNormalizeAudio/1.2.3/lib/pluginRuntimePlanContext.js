"use strict";

const {
  createRuntimePlanBuilders,
} = require("./runtimePlans");
const {
  createAudioCommandHelpers,
} = require("./audioCommandHelpers");

function createPluginRuntimePlanContext({
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
  cpuLoudnormNice,
  gpuPlanCoreCommand,
  maxGain,
  runtimeCuda,
  sourceCorePath,
  durationSeconds,
  usesStereoFallbackSourcePath,
}) {
  const {
    loudnormFilter,
    loudnessSummary,
    canSkipOriginalAformat,
    processingSampleRateFor,
    encodeSampleRateArgsFor,
    decodeAudioArgs,
    rawInputAudioArgs,
    chunkMiBFor,
    applyChunkMiBFor,
    buildCpuLoudnormMeasure,
    buildPairedCpuLoudnormMeasure,
  } = createAudioCommandHelpers({
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
    cpuLoudnormNice,
  });
  const {
    buildGpuFirstPassMeasure,
    buildRawSourcePortGpuPlan,
    buildStatsRuntimePlan,
    buildStreamingGpuPlan,
    buildPairedStreamingGpuPlan,
  } = createRuntimePlanBuilders({
    gpuPlanCoreCommand,
    ffmpegPath: args.ffmpegPath,
    decodeAudioArgs,
    processingSampleRateFor,
    targetI,
    targetLra,
    targetTp,
    maxGain,
    chunkMiBFor,
    applyChunkMiBFor,
    runtimeCuda,
    sourceCorePath,
    durationSeconds,
    usesStereoFallbackSourcePath,
  });

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
    loudnessSummary,
    loudnormFilter,
    processingSampleRateFor,
    rawInputAudioArgs,
  };
}

module.exports = {
  createPluginRuntimePlanContext,
};
