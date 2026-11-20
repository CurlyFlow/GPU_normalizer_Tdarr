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
const {
  resolvePairedApplyDirectMuxPlan,
} = require("./pairedApplyDirectMuxPlan");

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
  const directMuxPlan = resolvePairedApplyDirectMuxPlan({
    args,
    directMuxStrategy,
    fallbackPlan,
    originalPlan,
    audioPlans,
  });
  const {
    directMuxEnabled,
    directMuxFdWrites,
    directMuxInputPlans,
    directMuxPipeFds,
    directMuxPlanEnabled,
    directMuxRawInputPathFor,
    encodedInputPlanIds,
  } = directMuxPlan;
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
    inputStreams: args.inputFileObj.ffProbeData.streams,
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
