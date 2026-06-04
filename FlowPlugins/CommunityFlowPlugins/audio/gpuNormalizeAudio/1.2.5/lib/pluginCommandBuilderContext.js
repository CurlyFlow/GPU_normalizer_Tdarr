"use strict";

const {
  createRawFileCommandBuilders,
} = require("./rawFileCommands");
const {
  createStreamingCommandBuilders,
} = require("./streamingCommands");

function createPluginCommandBuilderContext({
  args,
  sourceCorePath,
  gpuApplyPath,
  sampleRate,
  targetI,
  targetLra,
  targetTp,
  audioBitrate,
  decodeAudioArgs,
  processingSampleRateFor,
  rawInputAudioArgs,
  encodeSampleRateArgsFor,
  encodeThreadArgs,
  applyChunkMiBFor,
}) {
  const {
    buildStreamingDecodeCommand,
    buildStreamingEncodeCommand,
  } = createStreamingCommandBuilders({
    args,
    audioBitrate,
    decodeAudioArgs,
    encodeSampleRateArgsFor,
    encodeThreadArgs,
    processingSampleRateFor,
    rawInputAudioArgs,
  });
  const {
    buildRawApplyCommand,
    buildRawDecodeCommand,
    buildRawEncodeCommand,
    buildSourceCoreGainsCommand,
  } = createRawFileCommandBuilders({
    args,
    sourceCorePath,
    gpuApplyPath,
    sampleRate,
    targetI,
    targetLra,
    targetTp,
    audioBitrate,
    decodeAudioArgs,
    processingSampleRateFor,
    rawInputAudioArgs,
    encodeSampleRateArgsFor,
    encodeThreadArgs,
    applyChunkMiBFor,
  });

  return {
    buildRawApplyCommand,
    buildRawDecodeCommand,
    buildRawEncodeCommand,
    buildSourceCoreGainsCommand,
    buildStreamingDecodeCommand,
    buildStreamingEncodeCommand,
  };
}

module.exports = {
  createPluginCommandBuilderContext,
};
