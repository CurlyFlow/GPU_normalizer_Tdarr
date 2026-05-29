"use strict";

const {
  buildPairedApplyDirectMuxContext,
} = require("./pairedApplyDirectMuxContext");
const {
  buildPairedApplyGpuPlans,
} = require("./pairedApplyGpuPlans");
const {
  buildPairedApplyRuntimeShellContext,
} = require("./pairedApplyRuntimeShellContext");

function buildPairedApplyRuntimePlan({
  args,
  pairedApplyConfig,
  fallbackPlan,
  originalPlan,
  fallbackValues,
  originalValues,
  fallbackPrep,
  originalPrep,
  audioPlans,
  skippedAudioPlans,
  audioStreams,
  container,
  tmpOutputFilePath,
  pythonPath,
  audioBitrate,
  rawInputAudioArgs,
  encodeSampleRateArgsFor,
  encodeThreadArgs,
  canSkipOriginalAformat,
  processingSampleRateFor,
  buildStreamingEncodeCommand,
  buildStreamingGpuPlan,
  buildPairedStreamingGpuPlan,
  wrapRuntimeProfile,
}) {
  const {
    directMuxCommand,
    directMuxEnabled,
    directMuxInputPlans,
    fallbackEncodeCommand,
    originalEncodeCommand,
  } = buildPairedApplyDirectMuxContext({
    args,
    pairedApplyConfig,
    fallbackPlan,
    originalPlan,
    fallbackValues,
    originalValues,
    audioPlans,
    skippedAudioPlans,
    audioStreams,
    container,
    tmpOutputFilePath,
    pythonPath,
    audioBitrate,
    rawInputAudioArgs,
    encodeSampleRateArgsFor,
    encodeThreadArgs,
    buildStreamingEncodeCommand,
  });
  const {
    fallbackGpuPlanCommand,
    fallbackRate,
    originalGpuPlanCommand,
    originalRate,
    singleRuntimeGpuPlan,
  } = buildPairedApplyGpuPlans({
    pairedApplyConfig,
    fallbackPlan,
    originalPlan,
    fallbackValues,
    originalValues,
    fallbackPrep,
    originalPrep,
    fallbackEncodeCommand,
    originalEncodeCommand,
    processingSampleRateFor,
    buildStreamingGpuPlan,
    buildPairedStreamingGpuPlan,
    wrapRuntimeProfile,
  });
  const script = buildPairedApplyRuntimeShellContext({
    args,
    pairedApplyConfig,
    fallbackPlan,
    originalPlan,
    audioPlans,
    directMuxEnabled,
    directMuxInputPlans,
    directMuxCommand,
    fallbackRate,
    originalRate,
    fallbackGpuPlanCommand,
    originalGpuPlanCommand,
    singleRuntimeGpuPlan,
    canSkipOriginalAformat,
    pythonPath,
  });

  return {
    directMuxEnabled,
    script,
  };
}

module.exports = {
  buildPairedApplyRuntimePlan,
};
