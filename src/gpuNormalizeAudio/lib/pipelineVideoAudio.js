"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { inspectStreams, inspectMedia } = require("./mediaSourceProbe");
const { verifyMappedAudioClocks } = require("./mediaClockVerification");
const { probeAudioTimeline } = require("./mediaNativeAudioClock");
const { planAacPreservation, encodeClockPlan } = require("./audioClockPlan");
const { snapshotCarrier, runPreservingCarrier } = require("./mediaTransportCarrier");
const { audioPresentation, storedAudioPresentation, comparePreservedWindows, compareStageAudioWindows } = require("./mediaAudioWindow");
const { fileDigest } = require("./mediaEvidenceFiles");
const { framehash } = require("./mediaFrameEvidence");
const { comparePacketPayloads, copiedVideoShift } = require("./mediaClockEvidence");
const { verifyMetadataCarriers, verifyStreamMetadata, verifyCopiedStreamProperties } = require("./mediaMetadataEvidence");
const { verifyChapterCarrier } = require("./mediaChapterCarrier");

function verifyPreservedPayloads(source, template, output, sourceStreams, templateStreams, tools, directory) {
  const actual = inspectStreams(output, tools.ffprobe), audio = sourceStreams.filter(stream => stream.type === "audio");
  const templateMedia = inspectMedia(template, tools.ffprobe), outputMedia = inspectMedia(output, tools.ffprobe);
  assert.equal(actual.length, templateStreams.length, "Merged stream coverage changed");
  let ordinal = 0;
  return actual.map((stream, index) => {
    const before = stream.type === "audio" ? audio[ordinal++] : templateStreams[index];
    const input = stream.type === "audio" ? source : template;
    assert.ok(before); assert.equal(stream.type, templateStreams[index].type);
    verifyStreamMetadata(before, stream); verifyCopiedStreamProperties(before, stream);
    if (stream.type !== "audio") {
      const chapter = verifyChapterCarrier(templateMedia, outputMedia, before, stream, { numerator: "0", denominator: "1" });
      if (chapter) return { index, ...chapter };
    }
    const left = framehash(input, `0:${before.index}`, "copy", tools.ffmpeg, directory);
    const right = framehash(output, `0:${stream.index}`, "copy", tools.ffmpeg, directory);
    if (stream.type === "audio") return { index, status: "pass", ...comparePacketPayloads(left, right) };
    const shift = copiedVideoShift(left, right);
    assert.equal(shift.numerator, 0n, "Merged non-audio clock changed");
    return { index, status: "pass" };
  });
}

function repairVideoAudio(request, sourceStreams, templateStreams, offset, directory, tools) {
  const source = sourceStreams.filter(stream => stream.type === "audio"), candidate = templateStreams.filter(stream => stream.type === "audio");
  const available = fs.statfsSync(directory, { bigint: true });
  const required = BigInt(fileDigest(request.sourceFile).bytes + fileDigest(request.candidateFile).bytes) * 2n + 67108864n;
  assert.ok(available.bavail * available.bsize >= required, "Insufficient capacity for audio-preserving video mux");
  const presentation = audioPresentation(request.sourceFile);
  assert.equal(presentation.tracks.length, source.length); assert.equal(candidate.length, source.length);
  const plans = source.map((stream, index) => {
    assert.equal(stream.codec_name, "aac"); assert.equal(candidate[index].codec_name, "aac");
    const timeline = probeAudioTimeline(request.sourceFile, index, stream, tools.ffprobe, directory);
    return { streamIndex: candidate[index].index, sourceTrackId: presentation.tracks[index].id,
      plan: planAacPreservation(timeline, offset), durationRuns: presentation.tracks[index].durationRuns,
      declaredEnd: presentation.tracks[index].declaredEnd };
  });
  const carrier = snapshotCarrier(directory), plan = path.join(directory, "preserve-audio.txt");
  fs.writeFileSync(plan, encodeClockPlan(plans), { flag: "wx", mode: 0o600 });
  const planIdentity = fileDigest(plan), output = path.join(path.dirname(request.candidateFile), `.audio-preserved-${randomUUID()}.mp4`);
  runPreservingCarrier(carrier, request.sourceFile, request.candidateFile, output, plan);
  const outputIdentity = fileDigest(output);
  const outputPresentation = audioPresentation(output);
  const windows = comparePreservedWindows(presentation.tracks, outputPresentation.tracks, plans);
  const payloads = verifyPreservedPayloads(request.sourceFile, request.candidateFile, output, sourceStreams, templateStreams, tools, directory);
  const metadata = verifyMetadataCarriers(inspectMedia(request.candidateFile, tools.ffprobe), inspectMedia(output, tools.ffprobe),
    { numerator: "0", denominator: "1" });
  assert.deepEqual(fileDigest(plan), planIdentity, "Preservation plan changed");
  assert.deepEqual(fileDigest(output), outputIdentity, "Merged output changed during verification");
  return { output, windows, transport: { operation: "preserved", output: { file: output, identity: outputIdentity },
    carrier, plan: { file: plan, identity: planIdentity }, plans, windows,
    payloads, metadata, index: outputPresentation.index } };
}

function preserveVideoAudio(request, sourceStreams, templateStreams, audioMap, offset, directory, tools) {
  const spec = { sourceFile: request.sourceFile, candidateFile: request.candidateFile, sourceStreams,
    candidateStreams: templateStreams, audioMap, ffprobePath: tools.ffprobe, directory };
  const clock = verifyMappedAudioClocks(spec, offset);
  if (!clock.errors.length) {
    try {
      const windows = compareStageAudioWindows(storedAudioPresentation(request.sourceFile).tracks,
        storedAudioPresentation(request.candidateFile).tracks,
        templateStreams.filter(stream => stream.type === "audio").map(stream => stream.index), offset);
      return { output: request.candidateFile, transport: null, windows };
    } catch (error) { clock.errors.push(error.message); }
  }
  try { return repairVideoAudio(request, sourceStreams, templateStreams, offset, directory, tools); }
  catch (error) { throw Error(`${clock.errors.slice(0, 3).join("; ")}; audio transport held: ${error.message}`); }
}

module.exports = { preserveVideoAudio, verifyPreservedPayloads };
