"use strict";

const {
  buildDirectMuxCommand,
} = require("./outputMux");
const {
  buildDirectMuxRelayCommand,
} = require("./pairedApplyRelayCommands");

function buildPairedApplyDirectMuxContext({
  args,
  pairedApplyConfig,
  pairedApplyStrategy,
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
  const directMuxStrategy = pairedApplyStrategy.directMux;

  const directMuxEnabled = directMuxStrategy.requested
    && audioPlans.length === 2
    && audioPlans.every((plan) => plan.idx === fallbackPlan.idx || plan.idx === originalPlan.idx);
  if (directMuxStrategy.requested && !directMuxEnabled) {
    args.jobLog("GPU normalize paired direct mux requested but skipped: diagnostic currently requires exactly the paired original+stereo audio plans.");
  }
  const directMuxRelayCommandFor = (plan) => buildDirectMuxRelayCommand({
    plan,
    pythonPath,
    spliceRelay: directMuxStrategy.spliceRelay,
    outputPipeMiB: pairedApplyStrategy.pipes.outputMiB,
  });
  const fallbackEncodeCommand = directMuxEnabled && directMuxStrategy.directFifoWrite ? ["__loudnorm_open_fifo_write__", fallbackPlan.fifoOutput] : directMuxEnabled ? directMuxRelayCommandFor(fallbackPlan) : buildStreamingEncodeCommand(fallbackPlan, fallbackValues);
  const originalEncodeCommand = directMuxEnabled && directMuxStrategy.directFifoWrite ? ["__loudnorm_open_fifo_write__", originalPlan.fifoOutput] : directMuxEnabled ? directMuxRelayCommandFor(originalPlan) : buildStreamingEncodeCommand(originalPlan, originalValues);
  const valuesByPlan = new Map([
    [fallbackPlan.idx, fallbackValues],
    [originalPlan.idx, originalValues],
  ]);
  const directMuxInputPlans = directMuxEnabled && directMuxStrategy.fallbackFirst
    ? [fallbackPlan, originalPlan]
    : audioPlans;
  const directMuxCommand = buildDirectMuxCommand({
    enabled: directMuxEnabled,
    ffmpegPath: args.ffmpegPath,
    inputFile: args.inputFileObj._id,
    noProgress: directMuxStrategy.noProgress,
    directMuxInputPlans,
    audioPlans,
    skippedAudioPlans,
    valuesByPlan,
    threadQueueSize: directMuxStrategy.threadQueueSize,
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
