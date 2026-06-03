"use strict";

const {
  buildDirectMuxCommand,
} = require("./outputMux");
const {
  buildDirectMuxRelayCommand,
  buildOrchestratorFifoFdCommand,
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
  const directMuxFdWrites = directMuxEnabled && directMuxStrategy.orchestratorFifoFd ? {
    fallback: { path: fallbackPlan.fifoOutput, token: "__loudnorm_fifo_fd_fallback__" },
    original: { path: originalPlan.fifoOutput, token: "__loudnorm_fifo_fd_original__" },
  } : {};
  const fallbackEncodeCommand = directMuxEnabled && directMuxStrategy.orchestratorFifoFd ? buildOrchestratorFifoFdCommand("fallback") : directMuxEnabled && directMuxStrategy.directFifoWrite ? ["__loudnorm_open_fifo_write__", fallbackPlan.fifoOutput] : directMuxEnabled ? directMuxRelayCommandFor(fallbackPlan) : buildStreamingEncodeCommand(fallbackPlan, fallbackValues);
  const originalEncodeCommand = directMuxEnabled && directMuxStrategy.orchestratorFifoFd ? buildOrchestratorFifoFdCommand("original") : directMuxEnabled && directMuxStrategy.directFifoWrite ? ["__loudnorm_open_fifo_write__", originalPlan.fifoOutput] : directMuxEnabled ? directMuxRelayCommandFor(originalPlan) : buildStreamingEncodeCommand(originalPlan, originalValues);
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
    quietLog: directMuxStrategy.quietLog,
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
    directMuxFdWrites,
    directMuxInputPlans,
    fallbackEncodeCommand,
    originalEncodeCommand,
  };
}

module.exports = {
  buildPairedApplyDirectMuxContext,
};
