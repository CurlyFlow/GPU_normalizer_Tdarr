"use strict";

const {
  buildDirectMuxCommand,
  buildDirectRawAudioEncodeCommand,
} = require("./outputMux");
const {
  buildDirectMuxRelayCommand,
  buildOrchestratorFifoFdCommand,
  buildOrchestratorPipeFdCommand,
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
  const valuesByPlan = new Map([
    [fallbackPlan.idx, fallbackValues],
    [originalPlan.idx, originalValues],
  ]);
  const directMuxInputPlans = directMuxEnabled
    ? directMuxStrategy.originalOnly
      ? [originalPlan]
      : directMuxStrategy.fallbackFirst
        ? [fallbackPlan, originalPlan]
        : audioPlans
    : [];
  const encodedInputPlanIds = directMuxEnabled && directMuxStrategy.encodedFifoOriginal ? [originalPlan.idx] : [];
  const directMuxPlanEnabled = (plan) => directMuxEnabled && directMuxInputPlans.some((inputPlan) => inputPlan.idx === plan.idx);
  const fallbackDirectMux = directMuxPlanEnabled(fallbackPlan);
  const originalDirectMux = directMuxPlanEnabled(originalPlan);
  const directMuxFdWrites = directMuxEnabled && directMuxStrategy.orchestratorFifoFd ? {
    ...(fallbackDirectMux ? { fallback: { path: fallbackPlan.fifoOutput, token: "__loudnorm_fifo_fd_fallback__" } } : {}),
    ...(originalDirectMux ? { original: { path: originalPlan.fifoOutput, token: "__loudnorm_fifo_fd_original__" } } : {}),
  } : {};
  const directMuxPipeFds = directMuxEnabled && directMuxStrategy.osPipe ? {
    ...(fallbackDirectMux ? { fallback: { readToken: "__loudnorm_pipe_fd_fallback_read__", writeToken: "__loudnorm_pipe_fd_fallback_write__" } } : {}),
    ...(originalDirectMux ? { original: { readToken: "__loudnorm_pipe_fd_original_read__", writeToken: "__loudnorm_pipe_fd_original_write__" } } : {}),
  } : {};
  const directMuxRawInputPathFor = (plan) => {
    if (!directMuxStrategy.osPipe) return plan.fifoOutput;
    if (plan.idx === fallbackPlan.idx && directMuxPipeFds.fallback) return `pipe:${directMuxPipeFds.fallback.readToken}`;
    if (plan.idx === originalPlan.idx && directMuxPipeFds.original) return `pipe:${directMuxPipeFds.original.readToken}`;
    return plan.fifoOutput;
  };
  const directMuxCommand = directMuxStrategy.originalOnly ? buildDirectRawAudioEncodeCommand({
    enabled: directMuxEnabled,
    ffmpegPath: args.ffmpegPath,
    noProgress: directMuxStrategy.noProgress,
    quietLog: directMuxStrategy.quietLog,
    plan: originalPlan,
    values: originalValues,
    rawInputAudioArgs,
    rawInputPath: directMuxRawInputPathFor(originalPlan),
    encodeSampleRateArgsFor,
    encodeThreadArgs,
    audioBitrate,
  }) : buildDirectMuxCommand({
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
    rawInputPathFor: directMuxRawInputPathFor,
    encodedInputPlanIds,
    encodeSampleRateArgsFor,
    encodeThreadArgs,
  });

  const directMuxEncodeCommandFor = (plan, values, role) => {
    if (!directMuxPlanEnabled(plan)) return buildStreamingEncodeCommand(plan, values);
    if (directMuxStrategy.encodedFifoOriginal && plan.idx === originalPlan.idx) {
      return buildDirectRawAudioEncodeCommand({
        enabled: directMuxEnabled,
        ffmpegPath: args.ffmpegPath,
        noProgress: directMuxStrategy.noProgress,
        quietLog: directMuxStrategy.quietLog,
        plan,
        values,
        rawInputAudioArgs,
        rawInputPath: "pipe:0",
        outputFormat: "adts",
        outputPath: directMuxRawInputPathFor(plan),
        encodeSampleRateArgsFor,
        encodeThreadArgs,
        audioBitrate,
      });
    }
    if (directMuxStrategy.osPipe) return buildOrchestratorPipeFdCommand(role);
    if (directMuxStrategy.orchestratorFifoFd) return buildOrchestratorFifoFdCommand(role);
    if (directMuxStrategy.directFifoWrite) return ["__loudnorm_open_fifo_write__", plan.fifoOutput];
    return directMuxRelayCommandFor(plan);
  };
  const fallbackEncodeCommandFinal = directMuxEncodeCommandFor(fallbackPlan, fallbackValues, "fallback");
  const originalEncodeCommandFinal = directMuxEncodeCommandFor(originalPlan, originalValues, "original");

  return {
    directMuxCommand,
    directMuxCompletesOutput: directMuxEnabled && !directMuxStrategy.originalOnly,
    directMuxEnabled,
    directMuxFdWrites,
    directMuxInputPlans,
    directMuxPipeFds,
    fallbackEncodeCommand: fallbackEncodeCommandFinal,
    originalEncodeCommand: originalEncodeCommandFinal,
  };
}

module.exports = {
  buildPairedApplyDirectMuxContext,
};
