"use strict";

const { renderShellCommand } = require("./commandRenderer");
const {
  exactMovieTimescale,
  privateAacMovieArgs,
  buildCopyOriginalAudioSpecs,
  buildFinalAudioSpecs,
  directMuxInputFormatForPlan,
  directNormalizedSpec,
  encodedDirectNormalizedSpec,
  pushAacEncodeArgs,
  pushBasePackageMaps,
  pushContainerCopyCodecs,
  pushMp4MetadataTagsArgs,
  pushPreservedVideoTimescaleArgs,
  pushOutputAudioCodecs,
  pushOutputAudioMetadata,
  sourceAudioSpec,
} = require("./outputAudioSpecs");

function buildCopyOriginalCommand({
  ffmpegPath,
  inputFile,
  inputStreams = [],
  container,
  audioSpecs = null,
  audioStreams = [],
  audioPlansToCopy = null,
  audioBitrate = "192k",
  tmpOutputFilePath,
}) {
  const resolvedAudioSpecs = audioSpecs || buildCopyOriginalAudioSpecs(audioStreams, audioPlansToCopy);
  const copyArgs = [
    ffmpegPath, "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", inputFile,
  ];
  pushBasePackageMaps(copyArgs, resolvedAudioSpecs, { container, inputStreams });
  pushContainerCopyCodecs(copyArgs);
  pushOutputAudioCodecs(copyArgs, resolvedAudioSpecs, { audioBitrate, container });
  pushOutputAudioMetadata(copyArgs, resolvedAudioSpecs, inputStreams);
  pushMp4MetadataTagsArgs(copyArgs, container);
  pushPreservedVideoTimescaleArgs(copyArgs, container, inputStreams);
  copyArgs.push(tmpOutputFilePath);
  return renderShellCommand(copyArgs);
}

function buildFinalMuxCommand({
  ffmpegPath,
  inputFile,
  inputStreams = [],
  audioSpecs = null,
  audioPlans = [],
  skippedAudioPlans = [],
  container,
  audioStreams = [],
  audioBitrate = "192k",
  movieTimescale = null,
  normalizedInputOffsets = null,
  preserveInputTimestamps = false,
  tmpOutputFilePath,
}) {
  const resolvedAudioSpecs = audioSpecs || buildFinalAudioSpecs(audioPlans, skippedAudioPlans, audioStreams);
  const muxArgs = [ffmpegPath, "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y"];
  if (preserveInputTimestamps) muxArgs.push("-copyts");
  muxArgs.push("-i", inputFile);
  for (const spec of resolvedAudioSpecs) {
    if (spec.kind !== "normalizedFile") continue;
    const offset = normalizedInputOffsets?.get?.(spec.plan.normalizedAudio);
    if (offset) muxArgs.push("-itsoffset", String(offset));
    muxArgs.push("-i", spec.plan.normalizedAudio);
  }
  pushBasePackageMaps(muxArgs, resolvedAudioSpecs, { container, inputStreams });
  pushContainerCopyCodecs(muxArgs);
  pushOutputAudioCodecs(muxArgs, resolvedAudioSpecs, { audioBitrate, container });
  pushOutputAudioMetadata(muxArgs, resolvedAudioSpecs, inputStreams);
  pushMp4MetadataTagsArgs(muxArgs, container);
  pushPreservedVideoTimescaleArgs(muxArgs, container, inputStreams);
  if (movieTimescale !== null) muxArgs.push("-movie_timescale", String(exactMovieTimescale([movieTimescale])));
  muxArgs.push(tmpOutputFilePath);
  return renderShellCommand(muxArgs);
}

function buildDirectMuxCommand({
  enabled,
  ffmpegPath,
  inputFile,
  inputStreams = [],
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
  rawInputPathFor = (plan) => plan.fifoOutput,
  encodedInputPlanIds = [],
  encodeSampleRateArgsFor,
  encodeThreadArgs,
}) {
  if (!enabled) return "";
  const encodedInputPlanIdSet = new Set(encodedInputPlanIds);

  const directMuxArgs = [
    ffmpegPath, "-hide_banner", ...(noProgress || quietLog ? ["-loglevel", "error"] : []), "-nostats", "-nostdin",
    ...(noProgress ? [] : ["-progress", "pipe:2"]), "-y", "-i", inputFile,
  ];
  const directMuxInputIndex = new Map(directMuxInputPlans.map((plan, idx) => [plan.idx, idx + 1]));
  for (const plan of directMuxInputPlans) {
    const values = valuesByPlan.get(plan.idx);
    if (threadQueueSize > 0) directMuxArgs.push("-thread_queue_size", String(threadQueueSize));
    if (encodedInputPlanIdSet.has(plan.idx)) {
      directMuxArgs.push("-f", "aac", "-i", rawInputPathFor(plan));
    } else {
      directMuxArgs.push("-f", directMuxInputFormatForPlan(plan), ...rawInputAudioArgs(plan, values), "-i", rawInputPathFor(plan));
    }
  }
  const audioSpecs = [
    ...audioPlans.map((plan) => {
      const inputIndex = directMuxInputIndex.get(plan.idx);
      if (!inputIndex) throw new Error(`GPU direct mux missing normalized input for stream ${plan.idx}`);
      if (encodedInputPlanIdSet.has(plan.idx)) return encodedDirectNormalizedSpec(plan, inputIndex);
      return directNormalizedSpec(plan, inputIndex, valuesByPlan.get(plan.idx));
    }),
    ...skippedAudioPlans.map((plan) => sourceAudioSpec(plan, audioStreams)),
  ];
  pushBasePackageMaps(directMuxArgs, audioSpecs, { container, inputStreams });
  pushContainerCopyCodecs(directMuxArgs);
  pushOutputAudioCodecs(directMuxArgs, audioSpecs, {
    audioBitrate,
    container,
    encodeSampleRateArgsFor,
    encodeThreadArgs,
  });
  pushMp4MetadataTagsArgs(directMuxArgs, container);
  pushPreservedVideoTimescaleArgs(directMuxArgs, container, inputStreams);
  pushOutputAudioMetadata(directMuxArgs, audioSpecs, inputStreams);
  directMuxArgs.push(tmpOutputFilePath);
  return renderShellCommand(directMuxArgs);
}

function buildDirectRawAudioEncodeCommand({
  enabled,
  ffmpegPath,
  noProgress,
  quietLog,
  plan,
  values,
  rawInputAudioArgs,
  rawInputPath,
  outputFormat = "",
  outputPath = plan.normalizedAudio,
  encodeSampleRateArgsFor,
  encodeThreadArgs,
  audioBitrate = "192k",
}) {
  if (!enabled) return "";
  const encodeRateArgs = encodeSampleRateArgsFor(plan, values);
  const codecThreadArgs = encodeThreadArgs(plan);
  const encodeArgs = [
    ffmpegPath, "-hide_banner", ...(noProgress || quietLog ? ["-loglevel", "error"] : []), "-nostats", "-nostdin",
    ...(noProgress ? [] : ["-progress", "pipe:2"]), "-y",
    "-f", directMuxInputFormatForPlan(plan), ...rawInputAudioArgs(plan, values), "-i", rawInputPath,
  ];
  if (encodeRateArgs[0] === "-ar" && encodeRateArgs[1]) encodeArgs.push("-ar", encodeRateArgs[1]);
  if (codecThreadArgs[0] === "-threads" && codecThreadArgs[1]) encodeArgs.push("-threads", codecThreadArgs[1]);
  pushAacEncodeArgs(encodeArgs, 0, audioBitrate);
  if (outputFormat) encodeArgs.push("-f", outputFormat);
  encodeArgs.push(...privateAacMovieArgs(outputPath, outputFormat));
  encodeArgs.push(outputPath);
  return renderShellCommand(encodeArgs);
}

module.exports = {
  buildCopyOriginalCommand,
  buildDirectMuxCommand,
  buildDirectRawAudioEncodeCommand,
  buildFinalMuxCommand,
};
