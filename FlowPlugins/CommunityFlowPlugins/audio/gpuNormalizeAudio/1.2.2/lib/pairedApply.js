"use strict";

const {
  buildPairedApplyShellScript,
  buildPairedRuntimeLaunchLines,
  buildRuntimeLaunchCommand,
} = require("./pairedApplyShellScript");
const {
  buildDecodeRelayCommands,
  buildDirectMuxRelayCommand,
  buildPipeSizerCommands,
} = require("./pairedApplyRelayCommands");
const {
  mp4TrueHdOutputArgs,
  shouldEncodeCopiedAudioForMp4,
} = require("./audioPlans");

function q(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function pushContainerCopyCodecs(args) {
  args.push("-c:v", "copy", "-c:s", "copy", "-c:t", "copy", "-c:d", "copy");
}

function envFlag(name) {
  const value = process.env[name];
  if (value == null) return false;
  return ["1", "true", "TRUE", "yes", "YES"].includes(value);
}

function pushAacToolArgs(args, idx) {
  if (!envFlag("LOUDNORM_GPU_AAC_DISABLE_TOOLS")) return;
  args.push(`-aac_ms:a:${idx}`, "0", `-aac_is:a:${idx}`, "0", `-aac_pns:a:${idx}`, "0", `-aac_tns:a:${idx}`, "0");
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
  audioBitrate,
  tmpOutputFilePath,
  rawInputAudioArgs,
  encodeSampleRateArgsFor,
  encodeThreadArgs,
}) {
  if (!enabled) return "";
  const aacCoderFast = envFlag("LOUDNORM_GPU_AAC_CODER_FAST");
  const directMuxArgs = [q(ffmpegPath), "-hide_banner", ...(noProgress ? ["-loglevel", "error"] : []), "-nostats", "-nostdin", ...(noProgress ? [] : ["-progress", "pipe:2"]), "-y", "-i", q(inputFile)];
  const directMuxInputIndex = new Map(directMuxInputPlans.map((plan, idx) => [plan.idx, idx + 1]));
  for (const plan of directMuxInputPlans) {
    const values = valuesByPlan.get(plan.idx);
    if (threadQueueSize > 0) directMuxArgs.push("-thread_queue_size", String(threadQueueSize));
    directMuxArgs.push("-f", q(plan.rawGpuFormat), ...rawInputAudioArgs(plan, values).map(q), "-i", q(plan.fifoOutput));
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
    directMuxArgs.push(`-c:a:${idx}`, "aac", `-b:a:${idx}`, q(audioBitrate));
    if (aacCoderFast) directMuxArgs.push(`-aac_coder:a:${idx}`, "fast");
    pushAacToolArgs(directMuxArgs, idx);
    if (encodeRateArgs[0] === "-ar" && encodeRateArgs[1]) directMuxArgs.push(`-ar:a:${idx}`, q(encodeRateArgs[1]));
    if (codecThreadArgs[0] === "-threads" && codecThreadArgs[1]) directMuxArgs.push(`-threads:a:${idx}`, q(codecThreadArgs[1]));
  });
  const copiedTrueHdStreams = [];
  skippedAudioPlans.forEach((plan, idx) => {
    const outputAudioIdx = audioPlans.length + idx;
    const stream = audioStreams[plan.sourceIdx];
    if (shouldEncodeCopiedAudioForMp4(container, stream)) {
      directMuxArgs.push(`-c:a:${outputAudioIdx}`, "aac", `-b:a:${outputAudioIdx}`, q(audioBitrate));
      if (aacCoderFast) directMuxArgs.push(`-aac_coder:a:${outputAudioIdx}`, "fast");
      pushAacToolArgs(directMuxArgs, outputAudioIdx);
    } else {
      directMuxArgs.push(`-c:a:${outputAudioIdx}`, "copy");
      copiedTrueHdStreams.push(stream);
    }
  });
  directMuxArgs.push(...mp4TrueHdOutputArgs(container, copiedTrueHdStreams));
  let directMuxAudioIdx = 0;
  audioPlans.forEach((plan) => {
    directMuxArgs.push(`-metadata:s:a:${directMuxAudioIdx}`, q(`language=${plan.language}`));
    directMuxAudioIdx += 1;
  });
  skippedAudioPlans.forEach((plan) => {
    directMuxArgs.push(`-metadata:s:a:${directMuxAudioIdx}`, q(`language=${plan.language}`));
    directMuxAudioIdx += 1;
  });
  directMuxArgs.push(q(tmpOutputFilePath));
  return directMuxArgs.join(" ");
}

function buildDualDecodeCommand({
  ffmpegPath,
  sourceInput,
  sourceAudioIdx,
  originalRawFilter,
  originalFirstDecode,
  originalPlan,
  fallbackPlan,
  originalRate,
  fallbackRate,
  originalDecodeInput,
  fallbackDecodeInput,
  decodeFilterThreads,
}) {
  const filterGraph = `[0:a:${sourceAudioIdx}]asplit=2[orig_in][stereo_in];[orig_in]${originalRawFilter}[orig_raw];[stereo_in]aformat=channel_layouts=stereo[stereo_raw]`;
  const dualDecodeOutputs = originalFirstDecode ? [
    "-map", q("[orig_raw]"), "-ar", String(originalRate), "-f", q(originalPlan.rawInputFormat), q(originalDecodeInput),
    "-map", q("[stereo_raw]"), "-ar", String(fallbackRate), "-f", q(fallbackPlan.rawInputFormat), q(fallbackDecodeInput),
  ] : [
    "-map", q("[stereo_raw]"), "-ar", String(fallbackRate), "-f", q(fallbackPlan.rawInputFormat), q(fallbackDecodeInput),
    "-map", q("[orig_raw]"), "-ar", String(originalRate), "-f", q(originalPlan.rawInputFormat), q(originalDecodeInput),
  ];
  return [
    q(ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", q(sourceInput),
    ...(decodeFilterThreads > 0 ? ["-filter_threads", String(decodeFilterThreads)] : []),
    "-filter_complex", q(filterGraph),
    ...dualDecodeOutputs,
  ].join(" ");
}

module.exports = {
  buildDecodeRelayCommands,
  buildDirectMuxCommand,
  buildDirectMuxRelayCommand,
  buildDualDecodeCommand,
  buildPairedApplyShellScript,
  buildPairedRuntimeLaunchLines,
  buildPipeSizerCommands,
  buildRuntimeLaunchCommand,
};
