"use strict";

const {
  q,
} = require("./common");

function createRawFileCommandBuilders({
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
  const buildRawDecodeCommand = (plan, values) => [
    q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", q(plan.sourceInput),
    "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...decodeAudioArgs(plan).map(q), "-ar", String(processingSampleRateFor(plan, values)), "-f", q(plan.rawInputFormat), q(plan.rawInput),
  ].join(" ");

  const buildSourceCoreGainsCommand = (plan) => [
    q(sourceCorePath), "--stream", q(plan.rawInput), "/dev/null", String(sampleRate), String(plan.channels), q(plan.gains), String(targetI), String(targetLra), String(targetTp),
  ].join(" ");

  const buildRawApplyCommand = (plan) => [
    q(gpuApplyPath), q(plan.rawInput), q(plan.gains), q(plan.rawGpu), "--chunk-mib", q(applyChunkMiBFor(plan)),
  ].join(" ");

  const buildRawEncodeCommand = (plan, values) => [
    q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-f", q(plan.rawGpuFormat), ...rawInputAudioArgs(plan, values).map(q),
    "-i", q(plan.rawGpu), ...encodeSampleRateArgsFor(plan, values).map(q), ...encodeThreadArgs(plan).map(q), "-c:a", "aac", "-b:a", q(audioBitrate), q(plan.normalizedAudio),
  ].join(" ");

  return {
    buildRawApplyCommand,
    buildRawDecodeCommand,
    buildRawEncodeCommand,
    buildSourceCoreGainsCommand,
  };
}

module.exports = {
  createRawFileCommandBuilders,
};
