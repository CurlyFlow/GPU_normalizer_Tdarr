"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { inspectMedia } = require("./mediaSourceProbe");
const { framehash } = require("./mediaFrameEvidence");
const { copiedVideoShift } = require("./mediaClockEvidence");
const { movTextShiftOptions } = require("./mediaClockVerification");
const { isMkvToMp4Promotion, verifyMetadataCarriers, verifyPreparedMediaCarriers, verifyStreamMetadata, verifyCopiedStreamProperties } = require("./mediaMetadataEvidence");
const { verifyChapterCarrier } = require("./mediaChapterCarrier");
const { verifySubtitleExtractions } = require("./pipelineSubtitleEvidence");

function verifyPromotedSubtitle(sourceFile, candidateFile, source, candidate, tools) {
  const readText = (file, index) => {
    const run = spawnSync(tools.ffmpeg, ["-hide_banner", "-v", "error", "-nostdin", "-i", file,
      "-map", `0:${index}`, "-c:s", "text", "-f", "srt", "pipe:1"],
    { encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    if (run.error || run.status !== 0) throw Error("Promoted subtitle text could not be decoded");
    return run.stdout;
  };
  assert.equal(readText(candidateFile, candidate.index), readText(sourceFile, source.index),
    "Promoted subtitle cues or timestamps changed");
}

function packetCopy(sourceFile, candidateFile, source, candidate, offset, tools, directory) {
  if (source.codec_type !== candidate.codec_type || source.codec_name !== candidate.codec_name) throw Error("Retained auxiliary stream codec changed");
  const shift = copiedVideoShift(framehash(sourceFile, `0:${source.index}`, "copy", tools.ffmpeg, directory),
    framehash(candidateFile, `0:${candidate.index}`, "copy", tools.ffmpeg, directory),
    movTextShiftOptions(sourceFile, source, candidateFile, candidate, tools.ffprobe));
  if (shift.numerator * BigInt(offset.denominator) !== BigInt(offset.numerator) * shift.denominator) throw Error("Auxiliary presentation clock changed");
}

function preparationCarriers(request, chain, tools, directory) {
  const source = inspectMedia(request.originalFile, tools.ffprobe), candidate = inspectMedia(request.preparedFile, tools.ffprobe);
  const offset = chain.preparation.clock.common_offset;
  const { metadata, pairs } = verifyPreparedMediaCarriers(source, candidate, chain.preparation.intent.mapping.streams, offset);
  const copies = pairs.map(({ map, before, after, promotedSubtitle }) => {
    if (promotedSubtitle) verifyPromotedSubtitle(request.originalFile, request.preparedFile, before, after, tools);
    else if (!["video", "audio"].includes(map.type) && !verifyChapterCarrier(source, candidate, before, after, offset)) {
      packetCopy(request.originalFile, request.preparedFile, before, after, offset, tools, directory);
    }
    return { sourceIndex: map.sourceIndex, candidateIndex: map.preparedIndex, status: "pass" };
  });
  const extractions = verifySubtitleExtractions(request, chain.preparation, tools, directory);
  return { metadata, copies, extractions };
}

function audioCarriers(request, chain, tools, directory) {
  const source = inspectMedia(request.preparedFile, tools.ffprobe), candidate = inspectMedia(request.audioFile, tools.ffprobe);
  const offset = chain.audio.clock?.common_offset || { numerator: "0", denominator: "1" };
  const metadata = verifyMetadataCarriers(source, candidate, offset);
  if (!chain.audio.handoff) {
    assert.deepEqual(source, candidate, "Audio passthrough changed metadata");
    return { metadata, copies: source.streams.length, primaryAudio: source.streams.filter(stream => stream.codec_type === "audio").length };
  }
  const before = source.streams.filter(stream => stream.codec_type !== "audio"), after = candidate.streams.filter(stream => stream.codec_type !== "audio");
  if (before.length !== after.length) throw Error("Audio processing changed non-audio stream coverage");
  before.forEach((stream, index) => {
    verifyStreamMetadata(stream, after[index]);
    verifyCopiedStreamProperties(stream, after[index]);
    if (stream.codec_type !== "video" && !verifyChapterCarrier(source, candidate, stream, after[index], offset)) {
      packetCopy(request.preparedFile, request.audioFile, stream, after[index], offset, tools, directory);
    }
  });
  const sourceAudio = source.streams.filter(stream => stream.codec_type === "audio"), candidateAudio = candidate.streams.filter(stream => stream.codec_type === "audio");
  const maps = chain.audio.values ? chain.audio.values.request.maps : chain.audio.handoff.selection.maps;
  if (candidateAudio.length !== maps.length) throw Error("Audio metadata coverage changed");
  maps.forEach(map => verifyStreamMetadata(sourceAudio[map.sourceIndex], candidateAudio[map.candidateIndex], map.kind !== "copy"));
  return { metadata, copies: before.length, primaryAudio: maps.filter(map => !map.stereo).length, generatedStereo: maps.filter(map => map.stereo).length };
}

function verifyFinishCarriers(request, chain, tools, directory) {
  const preparation = preparationCarriers(request, chain, tools, directory);
  const audio = audioCarriers(request, chain, tools, directory);
  const videos = chain.videos.map(receipt => {
    const before = inspectMedia(receipt.request.sourceFile, tools.ffprobe);
    const after = inspectMedia(receipt.output.file, tools.ffprobe);
    return verifyMetadataCarriers(before, after, receipt.commonOffset, {
      containerPromotion: isMkvToMp4Promotion(before, after),
    });
  });
  return { status: "pass", preparation, audio, videos };
}

module.exports = { verifyFinishCarriers };
