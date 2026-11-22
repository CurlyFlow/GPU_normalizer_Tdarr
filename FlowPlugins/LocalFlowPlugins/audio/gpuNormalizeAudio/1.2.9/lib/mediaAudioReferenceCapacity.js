"use strict";

const fs = require("node:fs");
const { inspectMedia } = require("./mediaSourceProbe");
const { normalizesAudio } = require("./mediaAudioValueProtocol");

function referenceCapacityBytes(sourceBytes, duration, stream, map, audioCount) {
  if (map.kind === "copy") return 0;
  const seconds = Math.ceil(Number(duration)) + 3;
  const rate = Number(stream?.sample_rate), channels = Number(stream?.channels);
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 1 || !Number.isSafeInteger(seconds) || seconds < 4
      || !Number.isSafeInteger(rate) || rate < 1 || rate > 1000000
      || !Number.isSafeInteger(channels) || channels < 1 || channels > 64
      || !Number.isSafeInteger(audioCount) || audioCount < 1) throw Error("Reference capacity cannot be established");
  const reserve = 64 * 1024 * 1024;
  const encoded = seconds * 24000 * 2;
  const prepared = normalizesAudio(map) ? (map.stereo ? seconds * 192000 * 2 * 8
    : audioCount > 1 ? Math.min(sourceBytes, seconds * rate * channels * 8 + reserve) : 0) : 0;
  const copiedVideo = normalizesAudio(map) && !map.stereo && audioCount === 1 ? sourceBytes : 0;
  const required = reserve + prepared + copiedVideo + encoded;
  if (!Number.isSafeInteger(required)) throw Error("Reference capacity exceeds the supported byte range");
  return required;
}

function requireReferenceCapacity(request, map, directory, ffprobe) {
  if (map.kind === "copy") return;
  const media = inspectMedia(request.sourceFile, ffprobe);
  const audio = media.streams.filter(stream => stream.codec_type === "audio");
  const required = referenceCapacityBytes(fs.statSync(request.sourceFile).size, media.format?.duration,
    audio[map.sourceIndex], map, audio.length);
  const capacity = fs.statfsSync(directory, { bigint: true });
  if (capacity.bavail * capacity.bsize < BigInt(required)) throw Error("Insufficient private capacity for independent audio reference");
}

module.exports = { referenceCapacityBytes, requireReferenceCapacity };
