"use strict";

const { renderShellCommand } = require("./commandRenderer");

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
  const buildRawDecodeCommand = (plan, values) => renderShellCommand([
    args.ffmpegPath, "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", plan.sourceInput,
    "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...decodeAudioArgs(plan), "-ar", String(processingSampleRateFor(plan, values)), "-f", plan.rawInputFormat, plan.rawInput,
  ]);

  const buildSourceCoreGainsCommand = (plan) => renderShellCommand([
    sourceCorePath, "--stream", plan.rawInput, "/dev/null", String(sampleRate), String(plan.channels), plan.gains, String(targetI), String(targetLra), String(targetTp),
  ]);

  const buildRawApplyCommand = (plan) => renderShellCommand([
    gpuApplyPath, plan.rawInput, plan.gains, plan.rawGpu, "--chunk-mib", String(applyChunkMiBFor(plan)),
  ]);

  const buildRawEncodeCommand = (plan, values) => renderShellCommand([
    args.ffmpegPath, "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-f", plan.rawGpuFormat, ...rawInputAudioArgs(plan, values),
    "-i", plan.rawGpu, ...encodeSampleRateArgsFor(plan, values), ...encodeThreadArgs(plan), "-c:a", "aac", "-b:a", audioBitrate, plan.normalizedAudio,
  ]);

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
