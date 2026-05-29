"use strict";

const { q } = require("./common");
const { mp4TrueHdOutputArgs, shouldEncodeCopiedAudioForMp4 } = require("./audioPlans");

function pushContainerCopyCodecs(args) {
  args.push("-c:v", "copy", "-c:s", "copy", "-c:t", "copy", "-c:d", "copy");
}

function pushAudioCodec(args, audioIdx, { container, stream, audioBitrate }) {
  if (shouldEncodeCopiedAudioForMp4(container, stream)) {
    args.push(`-c:a:${audioIdx}`, "aac", `-b:a:${audioIdx}`, q(audioBitrate));
    return false;
  }
  args.push(`-c:a:${audioIdx}`, "copy");
  return true;
}

function buildCopyOriginalCommand({ ffmpegPath, inputFile, container, audioStreams, audioPlansToCopy = null, audioBitrate = "192k", tmpOutputFilePath }) {
  const copyArgs = [
    q(ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", q(inputFile),
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
    if (plan.language) copyArgs.push(`-metadata:s:a:${audioIdx}`, q(`language=${plan.language}`));
  });
  copyArgs.push(...mp4TrueHdOutputArgs(container, copiedTrueHdStreams), q(tmpOutputFilePath));
  return copyArgs.join(" ");
}

function buildFinalMuxCommand({ ffmpegPath, inputFile, audioPlans, skippedAudioPlans, container, audioStreams, audioBitrate = "192k", tmpOutputFilePath }) {
  const muxArgs = [q(ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", q(inputFile)];
  for (const plan of audioPlans) muxArgs.push("-i", q(plan.normalizedAudio));
  muxArgs.push("-map", "0:v?");
  audioPlans.forEach((_, idx) => muxArgs.push("-map", `${idx + 1}:a:0`));
  skippedAudioPlans.forEach((plan) => muxArgs.push("-map", `0:a:${plan.sourceAudioIdx}`));
  muxArgs.push("-map", "0:s?", "-map", "0:t?", "-map", "0:d?", "-map_chapters", "0", "-map_metadata", "0");
  pushContainerCopyCodecs(muxArgs);
  audioPlans.forEach((_, idx) => muxArgs.push(`-c:a:${idx}`, "copy"));
  let muxAudioIdx = 0;
  audioPlans.forEach((plan) => {
    muxArgs.push(`-metadata:s:a:${muxAudioIdx}`, q(`language=${plan.language}`));
    muxAudioIdx += 1;
  });
  const copiedTrueHdStreams = [];
  skippedAudioPlans.forEach((plan) => {
    const stream = audioStreams[plan.sourceIdx];
    if (pushAudioCodec(muxArgs, muxAudioIdx, { container, stream, audioBitrate })) copiedTrueHdStreams.push(stream);
    muxArgs.push(`-metadata:s:a:${muxAudioIdx}`, q(`language=${plan.language}`));
    muxAudioIdx += 1;
  });
  muxArgs.push(...mp4TrueHdOutputArgs(container, copiedTrueHdStreams), q(tmpOutputFilePath));
  return muxArgs.join(" ");
}

module.exports = {
  buildCopyOriginalCommand,
  buildFinalMuxCommand,
};
