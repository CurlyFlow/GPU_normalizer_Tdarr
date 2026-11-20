"use strict";

const assert = require("node:assert/strict");
const { inspectMedia, inspectStreams } = require("./mediaSourceProbe");
const { verifyClockFiles } = require("./mediaClockVerification");
const { verifyCopiedAudio } = require("./mediaCopiedAudio");
const { framehash } = require("./mediaFrameEvidence");
const { comparePacketPayloads, copiedVideoShift } = require("./mediaClockEvidence");
const { inspectAudioWindows, audioPresentation, compareTransportWindows } = require("./mediaAudioWindow");
const { verifyMetadataCarriers, verifyStreamMetadata, verifyCopiedStreamProperties } = require("./mediaMetadataEvidence");
const { verifyChapterCarrier } = require("./mediaChapterCarrier");

async function verifyTransportOutput(spec, output, plans, tools) {
  const streams = inspectStreams(output, tools.ffprobe);
  const clock = verifyClockFiles({ ...spec, candidateFile: output, candidateStreams: streams,
    ffmpegPath: tools.ffmpeg, ffprobePath: tools.ffprobe });
  assert.deepEqual(clock.errors, [], "Transported original clocks or copied video differ");
  const copyMap = spec.audioMap.map(map => ({ ...map, sourceIndex: map.candidateIndex, compareSamples: true }));
  const values = await verifyCopiedAudio({ sourceFile: spec.candidateFile, candidateFile: output,
    sourceStreams: spec.candidateStreams, candidateStreams: streams, audioMap: copyMap, ffmpegPath: tools.ffmpeg });
  assert.ok(values.every(item => item.status === "pass"), "Transport changed complete native audio samples");
  const before = inspectMedia(spec.candidateFile, tools.ffprobe), after = inspectMedia(output, tools.ffprobe);
  assert.equal(before.streams.length, after.streams.length, "Transport changed stream coverage");
  const payloads = [];
  before.streams.forEach((stream, index) => {
    verifyStreamMetadata(stream, after.streams[index]); verifyCopiedStreamProperties(stream, after.streams[index]);
    if (verifyChapterCarrier(before, after, stream, after.streams[index], { numerator: "0", denominator: "1" })) return;
    const input = framehash(spec.candidateFile, `0:${stream.index}`, "copy", tools.ffmpeg, spec.directory);
    const actual = framehash(output, `0:${after.streams[index].index}`, "copy", tools.ffmpeg, spec.directory);
    if (stream.codec_type === "audio") payloads.push({ index: payloads.length, ...comparePacketPayloads(input, actual) });
    else assert.equal(copiedVideoShift(input, actual).numerator, 0n, "Transport changed a retained stream clock");
  });
  const metadata = verifyMetadataCarriers(before, after, { numerator: "0", denominator: "1" });
  const tables = audioPresentation(output);
  const windows = compareTransportWindows(inspectAudioWindows(spec.candidateFile), tables, plans);
  return { clock, values, payloads, metadata, windows, index: tables.index };
}

module.exports = { verifyTransportOutput };
