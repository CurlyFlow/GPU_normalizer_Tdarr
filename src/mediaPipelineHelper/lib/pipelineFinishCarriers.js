"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { inspectMedia } = require("./mediaSourceProbe");
const { framehash } = require("./mediaFrameEvidence");
const { copiedVideoShift } = require("./mediaClockEvidence");
const { equivalentMovTextExtradata } = require("./mediaClockVerification");
const { isMkvToMp4Promotion, verifyMetadataCarriers, verifyStreamMetadata, verifyCopiedStreamProperties } = require("./mediaMetadataEvidence");
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
  const movText = source.codec_type === "subtitle" && source.codec_name === "mov_text";
  const shift = copiedVideoShift(framehash(sourceFile, `0:${source.index}`, "copy", tools.ffmpeg, directory),
    framehash(candidateFile, `0:${candidate.index}`, "copy", tools.ffmpeg, directory),
    movText ? { allowEquivalentExtradata: () => equivalentMovTextExtradata(sourceFile, source.index, candidateFile, candidate.index, tools.ffprobe) } : {});
  if (shift.numerator * BigInt(offset.denominator) !== BigInt(offset.numerator) * shift.denominator) throw Error("Auxiliary presentation clock changed");
}

function preparationCarriers(request, chain, tools, directory) {
  const source = inspectMedia(request.originalFile, tools.ffprobe), candidate = inspectMedia(request.preparedFile, tools.ffprobe);
  const offset = chain.preparation.clock.common_offset;
  const containerPromotion = isMkvToMp4Promotion(source, candidate);
  const metadata = verifyMetadataCarriers(source, candidate, offset, { containerPromotion });
  const copies = chain.preparation.intent.mapping.streams.map(map => {
    const before = source.streams.find(stream => stream.index === map.sourceIndex);
    const after = candidate.streams.find(stream => stream.index === map.preparedIndex);
    const promotedSubtitle = containerPromotion && before.codec_type === "subtitle"
      && ["subrip", "ass"].includes(before.codec_name) && after.codec_name === "mov_text";
    verifyStreamMetadata(before, after, promotedSubtitle, { containerPromotion });
    verifyCopiedStreamProperties(before, after, { containerPromotion });
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
