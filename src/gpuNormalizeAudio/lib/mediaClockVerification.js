"use strict";

const { fileDigest } = require("./mediaEvidenceFiles");
const { framehash } = require("./mediaFrameEvidence");
const { copiedVideoShift, compareAudioTimelines } = require("./mediaClockEvidence");
const { probeAudioTimeline } = require("./mediaNativeAudioClock");
const { resolveVideoMap } = require("./mediaClockProtocol");

function verifyMappedAudioClocks({ sourceFile, candidateFile, sourceStreams, candidateStreams, audioMap, ffprobePath, directory }, offset) {
  const sourceAudio = sourceStreams.filter(stream => stream.type === "audio");
  const candidateAudio = candidateStreams.filter(stream => stream.type === "audio");
  const errors = [], audio = [];
  if (audioMap.length === 0 && sourceAudio.length > 0) errors.push("Empty audio mapping requires an audio-free original");
  if (audioMap.length !== candidateAudio.length
      || audioMap.some((map, index) => map.candidateIndex !== index)) errors.push("Audio clock mapping is incomplete or unordered");
  for (const map of audioMap) {
    try {
      const source = sourceAudio[map.sourceIndex], candidate = candidateAudio[map.candidateIndex];
      if (!Number.isSafeInteger(map.sourceIndex) || map.sourceIndex < 0 || !source || !candidate) {
        throw new Error("Original or candidate timing stream is missing");
      }
      if (!Number.isSafeInteger(map.rate) || map.rate <= 0 || map.rate !== Number(candidate.sample_rate)
          || map.channels !== Number(candidate.channels)) throw new Error("Native audio specification differs or is unknown");
      if (![4, 8].includes(map.sampleBytes)) throw new Error("Unsupported clock evidence sample width");
      const timeline = compareAudioTimelines(
        probeAudioTimeline(sourceFile, map.sourceIndex, source, ffprobePath, directory),
        probeAudioTimeline(candidateFile, map.candidateIndex, candidate, ffprobePath, directory), offset);
      audio.push({ map_id: map.id, status: "pass", ...timeline });
    } catch (error) {
      audio.push({ map_id: map.id, status: "fail" });
      errors.push(`${map.id}: ${error.message}`);
    }
  }
  return { audio, errors };
}

function verifyVideoClocks({ sourceFile, candidateFile, sourceStreams, candidateStreams, videoMap = null, ffmpegPath, directory }) {
  const sourceVideos = sourceStreams.filter(stream => stream.type === "video");
  const candidateVideos = candidateStreams.filter(stream => stream.type === "video");
  const mappedVideos = resolveVideoMap(videoMap, sourceVideos.length);
  const errors = [], videos = [];
  let offset = { numerator: 0n, denominator: 1n };
  if (mappedVideos.length !== candidateVideos.length) errors.push("Video stream count changed");
  for (const map of mappedVideos) {
    const index = map.candidateIndex;
    try {
      const shift = copiedVideoShift(
        framehash(sourceFile, `0:v:${map.sourceIndex}`, "copy", ffmpegPath, directory),
        framehash(candidateFile, `0:v:${index}`, "copy", ffmpegPath, directory));
      if (index > 0 && shift.numerator * offset.denominator !== offset.numerator * shift.denominator) {
        throw new Error("Video streams do not share one timeline translation");
      }
      offset = shift;
      videos.push({ index, source_index: map.sourceIndex, status: "pass" });
    } catch (error) {
      videos.push({ index, source_index: map.sourceIndex, status: "fail" });
      errors.push(`video ${index}: ${error.message}`);
    }
  }
  return { source_video_streams: sourceVideos.length, videoMap: mappedVideos,
    required_video_streams: mappedVideos.length, videos, offset, errors };
}

function verifyClockFiles(spec) {
  const { sourceFile, candidateFile, sourceStreams, candidateStreams, audioMap, ffprobePath, directory } = spec;
  const inputs = [...new Set([sourceFile, candidateFile])].map(file => ({ file, identity: fileDigest(file) }));
  const { offset, errors, ...video } = verifyVideoClocks(spec);
  if (audioMap.length === 0 && video.required_video_streams === 0) errors.push("Media clock proof covers no streams");
  const clocks = verifyMappedAudioClocks({ sourceFile, candidateFile, sourceStreams, candidateStreams, audioMap, ffprobePath, directory }, offset);
  errors.push(...clocks.errors);
  for (const input of inputs) {
    if (JSON.stringify(fileDigest(input.file)) !== JSON.stringify(input.identity)) errors.push("Media input changed during A/V comparison");
  }
  return { inputs, ...video, audio: clocks.audio,
    common_offset: { numerator: String(offset.numerator), denominator: String(offset.denominator) }, errors };
}

module.exports = { verifyClockFiles, verifyVideoClocks, verifyMappedAudioClocks };
