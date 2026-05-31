"use strict";

const { envFlag } = require("./common");
const { mp4TrueHdOutputArgs, shouldEncodeCopiedAudioForMp4 } = require("./audioChannelHelpers");
const { renderShellCommand } = require("./commandRenderer");

function pushContainerCopyCodecs(args) {
  args.push("-c:v", "copy", "-c:s", "copy", "-c:t", "copy", "-c:d", "copy");
}

function pushAacToolArgs(args, idx) {
  args.push(`-aac_ms:a:${idx}`, "0", `-aac_is:a:${idx}`, "0", `-aac_pns:a:${idx}`, "0", `-aac_tns:a:${idx}`, "0");
}

function pushAacEncodeArgs(args, audioIdx, audioBitrate, { aacCoderFast = false, disableAacTools = false } = {}) {
  args.push(`-c:a:${audioIdx}`, "aac", `-b:a:${audioIdx}`, audioBitrate);
  if (aacCoderFast) args.push(`-aac_coder:a:${audioIdx}`, "fast");
  if (disableAacTools) pushAacToolArgs(args, audioIdx);
}

function pushAudioCodec(args, audioIdx, { container, stream, audioBitrate }) {
  if (shouldEncodeCopiedAudioForMp4(container, stream)) {
    pushAacEncodeArgs(args, audioIdx, audioBitrate);
    return false;
  }
  args.push(`-c:a:${audioIdx}`, "copy");
  return true;
}

function buildCopyOriginalCommand({ ffmpegPath, inputFile, container, audioStreams, audioPlansToCopy = null, audioBitrate = "192k", tmpOutputFilePath }) {
  const copyArgs = [
    ffmpegPath, "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", inputFile,
    "-map", "0:v?",
  ];
  const audioMaps = Array.isArray(audioPlansToCopy)
    ? audioPlansToCopy.map((plan) => ({ sourceAudioIdx: plan.sourceAudioIdx, sourceIdx: plan.sourceIdx, language: plan.language }))
    : audioStreams.map((_, idx) => ({ sourceAudioIdx: idx, sourceIdx: idx }));
  audioMaps.forEach((plan) => copyArgs.push("-map", `0:a:${plan.sourceAudioIdx}`));
  copyArgs.push("-map", "0:s?", "-map", "0:t?", "-map", "0:d?", "-map_chapters", "0", "-map_metadata", "0");
  pushContainerCopyCodecs(copyArgs);
  const copiedTrueHdStreams = [];
  audioMaps.forEach((plan, audioIdx) => {
    const stream = audioStreams[plan.sourceIdx];
    if (pushAudioCodec(copyArgs, audioIdx, { container, stream, audioBitrate })) copiedTrueHdStreams.push(stream);
    if (plan.language) copyArgs.push(`-metadata:s:a:${audioIdx}`, `language=${plan.language}`);
  });
  copyArgs.push(...mp4TrueHdOutputArgs(container, copiedTrueHdStreams), tmpOutputFilePath);
  return renderShellCommand(copyArgs);
}

function buildFinalMuxCommand({ ffmpegPath, inputFile, audioPlans, skippedAudioPlans, container, audioStreams, audioBitrate = "192k", tmpOutputFilePath }) {
  const muxArgs = [ffmpegPath, "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", inputFile];
  for (const plan of audioPlans) muxArgs.push("-i", plan.normalizedAudio);
  muxArgs.push("-map", "0:v?");
  audioPlans.forEach((_, idx) => muxArgs.push("-map", `${idx + 1}:a:0`));
  skippedAudioPlans.forEach((plan) => muxArgs.push("-map", `0:a:${plan.sourceAudioIdx}`));
  muxArgs.push("-map", "0:s?", "-map", "0:t?", "-map", "0:d?", "-map_chapters", "0", "-map_metadata", "0");
  pushContainerCopyCodecs(muxArgs);
  audioPlans.forEach((_, idx) => muxArgs.push(`-c:a:${idx}`, "copy"));
  let muxAudioIdx = 0;
  audioPlans.forEach((plan) => {
    muxArgs.push(`-metadata:s:a:${muxAudioIdx}`, `language=${plan.language}`);
    muxAudioIdx += 1;
  });
  const copiedTrueHdStreams = [];
  skippedAudioPlans.forEach((plan) => {
    const stream = audioStreams[plan.sourceIdx];
    if (pushAudioCodec(muxArgs, muxAudioIdx, { container, stream, audioBitrate })) copiedTrueHdStreams.push(stream);
    muxArgs.push(`-metadata:s:a:${muxAudioIdx}`, `language=${plan.language}`);
    muxAudioIdx += 1;
  });
  muxArgs.push(...mp4TrueHdOutputArgs(container, copiedTrueHdStreams), tmpOutputFilePath);
  return renderShellCommand(muxArgs);
}

function buildDirectMuxCommand({
  enabled,
  ffmpegPath,
  inputFile,
  noProgress,
  directMuxInputPlans,
  audioPlans,
  skippedAudioPlans,
  valuesByPlan,
  threadQueueSize,
  container,
  audioStreams,
  audioBitrate = "192k",
  tmpOutputFilePath,
  rawInputAudioArgs,
  encodeSampleRateArgsFor,
  encodeThreadArgs,
}) {
  if (!enabled) return "";

  const directMuxAacOptions = {
    aacCoderFast: envFlag("LOUDNORM_GPU_AAC_CODER_FAST"),
    disableAacTools: envFlag("LOUDNORM_GPU_AAC_DISABLE_TOOLS"),
  };
  const directMuxArgs = [
    ffmpegPath, "-hide_banner", ...(noProgress ? ["-loglevel", "error"] : []), "-nostats", "-nostdin",
    ...(noProgress ? [] : ["-progress", "pipe:2"]), "-y", "-i", inputFile,
  ];
  const directMuxInputIndex = new Map(directMuxInputPlans.map((plan, idx) => [plan.idx, idx + 1]));
  for (const plan of directMuxInputPlans) {
    const values = valuesByPlan.get(plan.idx);
    if (threadQueueSize > 0) directMuxArgs.push("-thread_queue_size", String(threadQueueSize));
    directMuxArgs.push("-f", plan.rawGpuFormat, ...rawInputAudioArgs(plan, values), "-i", plan.fifoOutput);
  }
  directMuxArgs.push("-map", "0:v?");
  audioPlans.forEach((plan) => directMuxArgs.push("-map", `${directMuxInputIndex.get(plan.idx)}:a:0`));
  skippedAudioPlans.forEach((plan) => directMuxArgs.push("-map", `0:a:${plan.sourceAudioIdx}`));
  directMuxArgs.push("-map", "0:s?", "-map", "0:t?", "-map", "0:d?", "-map_chapters", "0", "-map_metadata", "0");
  pushContainerCopyCodecs(directMuxArgs);
  audioPlans.forEach((plan, idx) => {
    const values = valuesByPlan.get(plan.idx);
    const encodeRateArgs = encodeSampleRateArgsFor(plan, values);
    const codecThreadArgs = encodeThreadArgs(plan);
    pushAacEncodeArgs(directMuxArgs, idx, audioBitrate, directMuxAacOptions);
    if (encodeRateArgs[0] === "-ar" && encodeRateArgs[1]) directMuxArgs.push(`-ar:a:${idx}`, encodeRateArgs[1]);
    if (codecThreadArgs[0] === "-threads" && codecThreadArgs[1]) directMuxArgs.push(`-threads:a:${idx}`, codecThreadArgs[1]);
  });
  const copiedTrueHdStreams = [];
  skippedAudioPlans.forEach((plan, idx) => {
    const outputAudioIdx = audioPlans.length + idx;
    const stream = audioStreams[plan.sourceIdx];
    if (shouldEncodeCopiedAudioForMp4(container, stream)) {
      pushAacEncodeArgs(directMuxArgs, outputAudioIdx, audioBitrate, directMuxAacOptions);
    } else {
      directMuxArgs.push(`-c:a:${outputAudioIdx}`, "copy");
      copiedTrueHdStreams.push(stream);
    }
  });
  directMuxArgs.push(...mp4TrueHdOutputArgs(container, copiedTrueHdStreams));
  let directMuxAudioIdx = 0;
  audioPlans.forEach((plan) => {
    directMuxArgs.push(`-metadata:s:a:${directMuxAudioIdx}`, `language=${plan.language}`);
    directMuxAudioIdx += 1;
  });
  skippedAudioPlans.forEach((plan) => {
    directMuxArgs.push(`-metadata:s:a:${directMuxAudioIdx}`, `language=${plan.language}`);
    directMuxAudioIdx += 1;
  });
  directMuxArgs.push(tmpOutputFilePath);
  return renderShellCommand(directMuxArgs);
}

module.exports = {
  buildCopyOriginalCommand,
  buildDirectMuxCommand,
  buildFinalMuxCommand,
};
