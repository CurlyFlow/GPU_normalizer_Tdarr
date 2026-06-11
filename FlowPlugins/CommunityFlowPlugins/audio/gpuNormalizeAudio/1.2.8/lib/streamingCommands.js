"use strict";

const { envFlag } = require("./common");

function streamingAacEncodeArgs() {
  const args = [];
  if (envFlag("LOUDNORM_GPU_STREAMING_AAC_CODER_FAST")) args.push("-aac_coder:a:0", "fast");
  if (envFlag("LOUDNORM_GPU_STREAMING_AAC_DISABLE_TOOLS")) {
    args.push("-aac_ms:a:0", "0", "-aac_is:a:0", "0", "-aac_pns:a:0", "0", "-aac_tns:a:0", "0");
  }
  return args;
}

function encodePipeFormatFor(plan) {
  if (!plan.stereoFallback && envFlag("LOUDNORM_GPU_ORIGINAL_ENCODE_PIPE_F32")) return "f32le";
  return plan.rawGpuFormat;
}

function createStreamingCommandBuilders({
  args,
  audioBitrate,
  decodeAudioArgs,
  encodeSampleRateArgsFor,
  encodeThreadArgs,
  ingressSampleRateFor,
  processingSampleRateFor,
  rawInputAudioArgs,
}) {
  const buildStreamingDecodeCommand = (plan, values) => [
    String(args.ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", String(plan.sourceInput),
    "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...decodeAudioArgs(plan), "-ar", String(ingressSampleRateFor(plan, values)), "-f", plan.rawInputFormat, "pipe:1",
  ];

  const buildStreamingEncodeCommand = (plan, values) => [
    String(args.ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-f", encodePipeFormatFor(plan), ...rawInputAudioArgs(plan, values),
    "-i", "pipe:0", ...encodeSampleRateArgsFor(plan, values), ...encodeThreadArgs(plan), "-c:a", "aac", "-b:a", audioBitrate, ...streamingAacEncodeArgs(), plan.normalizedAudio,
  ];

  return {
    buildStreamingDecodeCommand,
    buildStreamingEncodeCommand,
  };
}

module.exports = {
  createStreamingCommandBuilders,
};
