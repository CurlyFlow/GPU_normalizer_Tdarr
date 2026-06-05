"use strict";

function createStreamingCommandBuilders({
  args,
  audioBitrate,
  decodeAudioArgs,
  encodeSampleRateArgsFor,
  encodeThreadArgs,
  processingSampleRateFor,
  rawInputAudioArgs,
}) {
  const buildStreamingDecodeCommand = (plan, values) => [
    String(args.ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", String(plan.sourceInput),
    "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...decodeAudioArgs(plan), "-ar", String(processingSampleRateFor(plan, values)), "-f", plan.rawInputFormat, "pipe:1",
  ];

  const buildStreamingEncodeCommand = (plan, values) => [
    String(args.ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-f", plan.rawGpuFormat, ...rawInputAudioArgs(plan, values),
    "-i", "pipe:0", ...encodeSampleRateArgsFor(plan, values), ...encodeThreadArgs(plan), "-c:a", "aac", "-b:a", audioBitrate, plan.normalizedAudio,
  ];

  return {
    buildStreamingDecodeCommand,
    buildStreamingEncodeCommand,
  };
}

module.exports = {
  createStreamingCommandBuilders,
};
