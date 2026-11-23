"use strict";

const assert = require("node:assert/strict");
const { inspectStreams, inspectMedia } = require("./mediaSourceProbe");
const { framehash } = require("./mediaFrameEvidence");
const { copiedVideoShift, transformedPacketShift } = require("./mediaClockEvidence");
const { verifyMappedAudioClocks } = require("./mediaClockVerification");
const { verifyCopiedAudio } = require("./mediaCopiedAudio");
const { fileDigest } = require("./mediaEvidenceFiles");
const { isMkvToMp4Promotion, verifyMetadataCarriers } = require("./mediaMetadataEvidence");
const { preserveVideoAudio } = require("./pipelineVideoAudio");

function videoProperties(stream, normalizedRange = false) {
  return ["width", "height", "pix_fmt", "sample_aspect_ratio", "field_order", "color_range", "color_space",
    "color_transfer", "color_primaries", "chroma_location", "side_data_list"].map(key => {
    const value = stream[key] ?? null;
    if (normalizedRange && value === null) {
      if (key === "color_range") return [key, "tv"];
      // H.265 Annex E specifies chroma_loc_info_present_flag == 0 as `left` (type 0);
      // hevc_nvenc omits this flag on 4:2:0 `left` sources.
      if (key === "chroma_location") return [key, "left"];
    }
    return [key, value];
  });
}

function sameOffset(left, right) {
  return left.numerator * right.denominator === right.numerator * left.denominator;
}

function verifyEncodedAudioBytes(sourceLines, candidateLines) {
  const bytesOf = (lines) => {
    const packets = [];
    for (const line of lines) {
      if (!line || line.startsWith("#")) continue;
      const fields = line.split(",").map(f => f.trim());
      packets.push(`${fields[4]}:${fields[5]}`);
    }
    return packets;
  };
  const before = bytesOf(sourceLines), after = bytesOf(candidateLines);
  assert.ok(before.length > 0 && after.length > 0, "Missing encoded audio packets");
  // FFmpeg `-c:a copy` on edit-list MP4s can drop 1-2 boundary priming/padding
  // packets, which `preserveVideoAudio` restores from `sourceFile`. Still reject
  // any re-encoded, corrupted or truncated audio whose packets are not a
  // bit-identical contiguous slice of the untouched source packets.
  const trim = before.length - after.length;
  assert.ok(trim >= 0 && trim <= 2, `Encoded audio packet count changed (${after.length} !== ${before.length})`);
  for (let shift = 0; shift <= trim; shift++) {
    let matched = true;
    for (let index = 0; index < after.length; index++) {
      if (after[index] !== before[index + shift]) { matched = false; break; }
    }
    if (matched) return;
  }
  assert.fail("Encoded audio packet payload changed");
}

async function verifyVideoStage(request, directory, tools) {
  const source = inspectStreams(request.sourceFile, tools.ffprobe), candidate = inspectStreams(request.candidateFile, tools.ffprobe);
  const sourceVideo = source.filter(stream => stream.type === "video"), candidateVideo = candidate.filter(stream => stream.type === "video");
  const sourceAudio = source.filter(stream => stream.type === "audio"), candidateAudio = candidate.filter(stream => stream.type === "audio");
  const sourceSubtitles = source.filter(stream => stream.type === "subtitle"), candidateSubtitles = candidate.filter(stream => stream.type === "subtitle");
  if (!sourceVideo.length || candidateVideo.length !== sourceVideo.length) throw Error("Video stage frame coverage changed");
  if (candidateAudio.length !== sourceAudio.length) throw Error("Video stage audio stream count changed");
  if (candidateSubtitles.length !== sourceSubtitles.length + request.sidecars.length) throw Error("Video stage subtitle stream count changed");
  const converted = sourceVideo.some(stream => stream.codec_name !== "hevc");
  if (converted !== (request.encoder !== null)) throw Error("Executed video encoder does not match source codecs");
  let offset = null;
  const videos = sourceVideo.map((stream, index) => {
    const actual = candidateVideo[index];
    if (stream.codec_name !== "hevc" && (["smpte2084", "arib-std-b67"].includes(stream.color_transfer)
        || (stream.side_data_list || []).length)) throw Error("HDR/side-data video conversion lacks an independently admitted carrier transform");
    const transcoded = stream.codec_name !== "hevc";
    assert.deepEqual(videoProperties(actual, transcoded), videoProperties(stream, transcoded), "Video native pixels, geometry, color or HDR metadata changed");
    if (actual.codec_name !== "hevc") throw Error("Video stage did not produce the intended HEVC codec");
    const sourcePackets = framehash(request.sourceFile, `0:v:${index}`, "copy", tools.ffmpeg, directory);
    const candidatePackets = framehash(request.candidateFile, `0:v:${index}`, "copy", tools.ffmpeg, directory);
    const shift = transcoded
      ? transformedPacketShift(sourcePackets, candidatePackets)
      : copiedVideoShift(sourcePackets, candidatePackets);
    if (offset && !sameOffset(offset, shift)) throw Error("Video streams have independent timeline shifts");
    offset = shift;
    return { index, status: "pass", kind: transcoded ? "hevc_nvenc" : "copy" };
  });
  const referencePackets = candidate.map((_, index) => ({ index, status: "pass" }));
  sourceAudio.forEach((_, index) => {
    verifyEncodedAudioBytes(
      framehash(request.sourceFile, `0:a:${index}`, "copy", tools.ffmpeg, directory),
      framehash(request.candidateFile, `0:a:${index}`, "copy", tools.ffmpeg, directory),
    );
  });
  const audioMap = sourceAudio.map((stream, index) => ({ id: `video-a${index}`,
    sourceIndex: index, candidateIndex: index, channels: Number(stream.channels), rate: Number(stream.sample_rate), sampleBytes: 8, compareSamples: true }));
  const preserved = preserveVideoAudio(request, source, candidate, audioMap, offset, directory, tools);
  const spec = { sourceFile: request.sourceFile, candidateFile: preserved.output, sourceStreams: source,
    candidateStreams: inspectStreams(preserved.output, tools.ffprobe), audioMap, ffmpegPath: tools.ffmpeg, ffprobePath: tools.ffprobe, directory };
  const clock = verifyMappedAudioClocks(spec, offset);
  const copiedAudio = await verifyCopiedAudio(spec);
  const errors = [...clock.errors, ...copiedAudio.flatMap(item => item.errors)];
  const beforeMedia = inspectMedia(request.sourceFile, tools.ffprobe);
  const afterMedia = inspectMedia(preserved.output, tools.ffprobe);
  const metadata = verifyMetadataCarriers(beforeMedia, afterMedia,
    { numerator: String(offset.numerator), denominator: String(offset.denominator) },
    { containerPromotion: isMkvToMp4Promotion(beforeMedia, afterMedia) });
  return { reference: null, referencePackets, videos,
    commonOffset: { numerator: String(offset.numerator), denominator: String(offset.denominator) },
    audio: clock.audio, audioWindows: preserved.windows, copiedAudio, metadata, errors, output: { file: preserved.output, identity: fileDigest(preserved.output) },
    transport: preserved.transport };
}

module.exports = { verifyVideoStage };
