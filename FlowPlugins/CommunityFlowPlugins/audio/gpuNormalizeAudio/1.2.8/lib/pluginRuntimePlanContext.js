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
    ingressSampleRateFor,
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
    buildGpuFirstPassInputMeasure,
    buildGpuFirstPassMeasure,
    buildGpuFirstPassMixedSharedDecode,
    buildGpuFirstPassMixedSharedStats,
    buildGpuFirstPassOutputApplyFromStats,
    buildRawSourcePortGpuPlan,
    buildStatsRuntimePlan,
    buildStreamingGpuPlan,
    buildPairedStreamingGpuPlan,
  } = createRuntimePlanBuilders({
    gpuPlanCoreCommand,
    ffmpegPath: args.ffmpegPath,
    decodeAudioArgs,
    ingressSampleRateFor,
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
    buildGpuFirstPassInputMeasure,
    buildGpuFirstPassMeasure,
    buildGpuFirstPassMixedSharedDecode,
    buildGpuFirstPassMixedSharedStats,
    buildGpuFirstPassOutputApplyFromStats,
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
    ingressSampleRateFor,
    processingSampleRateFor,
    rawInputAudioArgs,
  };
}

module.exports = {
  createPluginRuntimePlanContext,
};
