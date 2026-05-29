"use strict";

const {
  buildDirectMuxCommand,
  buildDirectMuxRelayCommand,
} = require("./pairedApply");

function buildPairedApplyDirectMuxContext({
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
}) {
  const {
    pairStereoFallbackApplyDirectFifoWrite,
    pairStereoFallbackApplyDirectMux,
    pairStereoFallbackApplyDirectMuxFallbackFirst,
    pairStereoFallbackApplyDirectMuxNoProgress,
    pairStereoFallbackApplyDirectMuxThreadQueueSize,
    pairStereoFallbackApplyOutputPipeMiB,
    pairStereoFallbackApplySpliceRelay,
  } = pairedApplyConfig;

  const directMuxEnabled = pairStereoFallbackApplyDirectMux
    && audioPlans.length === 2
    && audioPlans.every((plan) => plan.idx === fallbackPlan.idx || plan.idx === originalPlan.idx);
  if (pairStereoFallbackApplyDirectMux && !directMuxEnabled) {
    args.jobLog("GPU normalize paired direct mux requested but skipped: diagnostic currently requires exactly the paired original+stereo audio plans.");
  }
  const directMuxRelayCommandFor = (plan) => pairStereoFallbackApplySpliceRelay
    ? buildDirectMuxRelayCommand({ plan, pythonPath, spliceRelay: true, outputPipeMiB: pairStereoFallbackApplyOutputPipeMiB })
    : buildDirectMuxRelayCommand({ plan, pythonPath, spliceRelay: false, outputPipeMiB: pairStereoFallbackApplyOutputPipeMiB });
  const fallbackEncodeCommand = directMuxEnabled && pairStereoFallbackApplyDirectFifoWrite ? ["__loudnorm_open_fifo_write__", fallbackPlan.fifoOutput] : directMuxEnabled ? directMuxRelayCommandFor(fallbackPlan) : buildStreamingEncodeCommand(fallbackPlan, fallbackValues);
  const originalEncodeCommand = directMuxEnabled && pairStereoFallbackApplyDirectFifoWrite ? ["__loudnorm_open_fifo_write__", originalPlan.fifoOutput] : directMuxEnabled ? directMuxRelayCommandFor(originalPlan) : buildStreamingEncodeCommand(originalPlan, originalValues);
  const valuesByPlan = new Map([
    [fallbackPlan.idx, fallbackValues],
    [originalPlan.idx, originalValues],
  ]);
  const directMuxInputPlans = directMuxEnabled && pairStereoFallbackApplyDirectMuxFallbackFirst
    ? [fallbackPlan, originalPlan]
    : audioPlans;
  const directMuxCommand = buildDirectMuxCommand({
    enabled: directMuxEnabled,
    ffmpegPath: args.ffmpegPath,
    inputFile: args.inputFileObj._id,
    noProgress: pairStereoFallbackApplyDirectMuxNoProgress,
    directMuxInputPlans,
    audioPlans,
    skippedAudioPlans,
    valuesByPlan,
    threadQueueSize: pairStereoFallbackApplyDirectMuxThreadQueueSize,
    container,
    audioStreams,
    audioBitrate,
    tmpOutputFilePath,
    rawInputAudioArgs,
    encodeSampleRateArgsFor,
    encodeThreadArgs,
  });

  return {
    directMuxCommand,
    directMuxEnabled,
    directMuxInputPlans,
    fallbackEncodeCommand,
    originalEncodeCommand,
  };
}

module.exports = {
  buildPairedApplyDirectMuxContext,
};
