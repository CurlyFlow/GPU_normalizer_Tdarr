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

function pushAudioCodec(args, audioIdx, { container, stream, audioBitrate, aacOptions = {} }) {
  if (shouldEncodeCopiedAudioForMp4(container, stream)) {
    pushAacEncodeArgs(args, audioIdx, audioBitrate, aacOptions);
    return false;
  }
  args.push(`-c:a:${audioIdx}`, "copy");
  return true;
}

function sourceAudioSpec(plan, audioStreams) {
  return {
    kind: "source",
    mapArg: `0:a:${plan.sourceAudioIdx}`,
    language: plan.language,
    stream: audioStreams[plan.sourceIdx],
  };
}

function sourceStreamSpec(stream, idx) {
  return {
    kind: "source",
    mapArg: `0:a:${idx}`,
    language: null,
    stream,
  };
}

function normalizedFileSpec(plan, inputIndex) {
  return {
    kind: "normalizedFile",
    mapArg: `${inputIndex}:a:0`,
    language: plan.language,
  };
}

function directNormalizedSpec(plan, inputIndex, values) {
  return {
    kind: "directNormalized",
    mapArg: `${inputIndex}:a:0`,
    language: plan.language,
    plan,
    values,
  };
}

function pushBasePackageMaps(args, audioSpecs) {
  args.push("-map", "0:v?");
  audioSpecs.forEach((spec) => args.push("-map", spec.mapArg));
  args.push("-map", "0:s?", "-map", "0:t?", "-map", "0:d?", "-map_chapters", "0", "-map_metadata", "0");
}

function pushOutputAudioCodecs(args, audioSpecs, {
  audioBitrate,
  container,
  directMuxAacOptions = {},
  encodeSampleRateArgsFor = null,
  encodeThreadArgs = null,
}) {
  const copiedTrueHdStreams = [];
  audioSpecs.forEach((spec, audioIdx) => {
    if (spec.kind === "normalizedFile") {
      args.push(`-c:a:${audioIdx}`, "copy");
      return;
    }
    if (spec.kind === "directNormalized") {
      const encodeRateArgs = encodeSampleRateArgsFor(spec.plan, spec.values);
      const codecThreadArgs = encodeThreadArgs(spec.plan);
      pushAacEncodeArgs(args, audioIdx, audioBitrate, directMuxAacOptions);
      if (encodeRateArgs[0] === "-ar" && encodeRateArgs[1]) args.push(`-ar:a:${audioIdx}`, encodeRateArgs[1]);
      if (codecThreadArgs[0] === "-threads" && codecThreadArgs[1]) args.push(`-threads:a:${audioIdx}`, codecThreadArgs[1]);
      return;
    }
    if (pushAudioCodec(args, audioIdx, {
      container,
      stream: spec.stream,
      audioBitrate,
      aacOptions: directMuxAacOptions,
    })) {
      copiedTrueHdStreams.push(spec.stream);
    }
  });
  return copiedTrueHdStreams;
}

function pushOutputAudioMetadata(args, audioSpecs) {
  audioSpecs.forEach((spec, audioIdx) => {
    if (spec.language) args.push(`-metadata:s:a:${audioIdx}`, `language=${spec.language}`);
  });
}

function buildCopyOriginalCommand({ ffmpegPath, inputFile, container, audioStreams, audioPlansToCopy = null, audioBitrate = "192k", tmpOutputFilePath }) {
  const copyArgs = [
    ffmpegPath, "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", inputFile,
  ];
  const audioSpecs = Array.isArray(audioPlansToCopy)
    ? audioPlansToCopy.map((plan) => sourceAudioSpec(plan, audioStreams))
    : audioStreams.map(sourceStreamSpec);
  pushBasePackageMaps(copyArgs, audioSpecs);
  pushContainerCopyCodecs(copyArgs);
  const copiedTrueHdStreams = pushOutputAudioCodecs(copyArgs, audioSpecs, { audioBitrate, container, directMuxAacOptions: {} });
  pushOutputAudioMetadata(copyArgs, audioSpecs);
  copyArgs.push(...mp4TrueHdOutputArgs(container, copiedTrueHdStreams), tmpOutputFilePath);
  return renderShellCommand(copyArgs);
}

function buildFinalMuxCommand({ ffmpegPath, inputFile, audioPlans, skippedAudioPlans, container, audioStreams, audioBitrate = "192k", tmpOutputFilePath }) {
  const muxArgs = [ffmpegPath, "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", inputFile];
  for (const plan of audioPlans) muxArgs.push("-i", plan.normalizedAudio);
  const audioSpecs = [
    ...audioPlans.map((plan, idx) => normalizedFileSpec(plan, idx + 1)),
    ...skippedAudioPlans.map((plan) => sourceAudioSpec(plan, audioStreams)),
  ];
  pushBasePackageMaps(muxArgs, audioSpecs);
  pushContainerCopyCodecs(muxArgs);
  const copiedTrueHdStreams = pushOutputAudioCodecs(muxArgs, audioSpecs, { audioBitrate, container, directMuxAacOptions: {} });
  pushOutputAudioMetadata(muxArgs, audioSpecs);
  muxArgs.push(...mp4TrueHdOutputArgs(container, copiedTrueHdStreams), tmpOutputFilePath);
  return renderShellCommand(muxArgs);
}

function buildDirectMuxCommand({
  enabled,
  ffmpegPath,
  inputFile,
  noProgress,
  quietLog,
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
    ffmpegPath, "-hide_banner", ...(noProgress || quietLog ? ["-loglevel", "error"] : []), "-nostats", "-nostdin",
    ...(noProgress ? [] : ["-progress", "pipe:2"]), "-y", "-i", inputFile,
  ];
  const directMuxInputIndex = new Map(directMuxInputPlans.map((plan, idx) => [plan.idx, idx + 1]));
  for (const plan of directMuxInputPlans) {
    const values = valuesByPlan.get(plan.idx);
    if (threadQueueSize > 0) directMuxArgs.push("-thread_queue_size", String(threadQueueSize));
    directMuxArgs.push("-f", plan.rawGpuFormat, ...rawInputAudioArgs(plan, values), "-i", plan.fifoOutput);
  }
  const audioSpecs = [
    ...audioPlans.map((plan) => {
      const inputIndex = directMuxInputIndex.get(plan.idx);
      if (!inputIndex) throw new Error(`GPU direct mux missing normalized input for stream ${plan.idx}`);
      return directNormalizedSpec(plan, inputIndex, valuesByPlan.get(plan.idx));
    }),
    ...skippedAudioPlans.map((plan) => sourceAudioSpec(plan, audioStreams)),
  ];
  pushBasePackageMaps(directMuxArgs, audioSpecs);
  pushContainerCopyCodecs(directMuxArgs);
  const copiedTrueHdStreams = pushOutputAudioCodecs(directMuxArgs, audioSpecs, {
    audioBitrate,
    container,
    directMuxAacOptions,
    encodeSampleRateArgsFor,
    encodeThreadArgs,
  });
  directMuxArgs.push(...mp4TrueHdOutputArgs(container, copiedTrueHdStreams));
  pushOutputAudioMetadata(directMuxArgs, audioSpecs);
  directMuxArgs.push(tmpOutputFilePath);
  return renderShellCommand(directMuxArgs);
}

module.exports = {
  buildCopyOriginalCommand,
  buildDirectMuxCommand,
  buildFinalMuxCommand,
};
