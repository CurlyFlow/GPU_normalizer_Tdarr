"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { fileDigest, sameFileGeneration } = require("./mediaEvidenceFiles");
const { inspectStreams } = require("./mediaSourceProbe");
const { framehash } = require("./mediaFrameEvidence");
const { copiedVideoShift } = require("./mediaClockEvidence");

function subtitleIdentity(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file) throw Error("Subtitle companion is not a canonical single-link file");
  return fileDigest(file);
}

function bindSubtitleExtractions(targets, allowMissing) {
  return targets.flatMap(target => {
    if (allowMissing && !fs.existsSync(target.file)) return [];
    return [{ ...target, identity: subtitleIdentity(target.file) }];
  });
}

function verifySubtitleExtractions(request, preparation, tools, directory) {
  const records = preparation.intent.actual.subtitles;
  if (!Array.isArray(records) || records.length > 256) throw Error("Missing subtitle extraction inventory");
  return records.map(record => {
    const source = preparation.source.ffProbeData.streams.find(stream => stream.index === record.sourceIndex);
    if (source?.codec_type !== "subtitle" || source.codec_name !== "subrip"
        || !sameFileGeneration(record.identity, subtitleIdentity(record.file))) throw Error("Subtitle extraction generation changed");
    const streams = inspectStreams(record.file, tools.ffprobe);
    if (streams.length !== 1 || streams[0].codec_type !== "subtitle" || streams[0].codec_name !== "subrip") {
      throw Error("Subtitle extraction has unexpected stream coverage");
    }
    const shift = copiedVideoShift(framehash(request.originalFile, `0:${source.index}`, "copy", tools.ffmpeg, directory),
      framehash(record.file, "0:s:0", "copy", tools.ffmpeg, directory));
    assert.equal(shift.numerator, 0n, "Extracted subtitle presentation clock changed");
    if (!sameFileGeneration(record.identity, subtitleIdentity(record.file))) throw Error("Subtitle changed during extraction verification");
    return { sourceIndex: record.sourceIndex, file: record.file, identity: record.identity, status: "pass" };
  });
}

module.exports = { bindSubtitleExtractions, verifySubtitleExtractions };
