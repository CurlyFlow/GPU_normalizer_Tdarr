"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { planVideo } = require("./pipelineVideo");
const { inspectStreams, inspectMedia } = require("./mediaSourceProbe");
const { framehash } = require("./mediaFrameEvidence");
const { copiedVideoShift, transformedVideoShift } = require("./mediaClockEvidence");
const { verifyMappedAudioClocks } = require("./mediaClockVerification");
const { verifyCopiedAudio } = require("./mediaCopiedAudio");
const { fileDigest } = require("./mediaEvidenceFiles");
const { verifyMetadataCarriers } = require("./mediaMetadataEvidence");
const { preserveVideoAudio } = require("./pipelineVideoAudio");
const { verifyChapterCarrier } = require("./mediaChapterCarrier");

function videoProperties(stream) {
  return ["width", "height", "pix_fmt", "sample_aspect_ratio", "field_order", "color_range", "color_space",
    "color_transfer", "color_primaries", "chroma_location", "side_data_list"].map(key => [key, stream[key] ?? null]);
}

function sameOffset(left, right) {
  return left.numerator * right.denominator === right.numerator * left.denominator;
}

async function verifyVideoStage(request, directory, tools) {
  const source = inspectStreams(request.sourceFile, tools.ffprobe), candidate = inspectStreams(request.candidateFile, tools.ffprobe);
  const sourceVideo = source.filter(stream => stream.type === "video"), candidateVideo = candidate.filter(stream => stream.type === "video");
  if (!sourceVideo.length || candidateVideo.length !== sourceVideo.length) throw Error("Video stage frame coverage changed");
  const converted = sourceVideo.some(stream => stream.codec_name !== "hevc");
  if (converted !== (request.encoder !== null)) throw Error("Executed video encoder does not match source codecs");
  const available = fs.statfsSync(directory, { bigint: true });
  const required = BigInt(Math.max(fs.statSync(request.sourceFile).size, fs.statSync(request.candidateFile).size)) * 2n + 67108864n;
  if (available.bavail * available.bsize < required) throw Error("Insufficient private capacity for independent video reference");
  const referenceFile = path.join(directory, "independent-reference.mp4");
  const plan = planVideo({ _id: request.sourceFile, ffProbeData: { streams: source } }, request.settings, request.sidecars, request.encoder || undefined);
  const run = spawnSync(tools.ffmpeg, ["-hide_banner", "-v", "error", "-xerror", "-nostdin", "-n",
    ...plan.inputs, ...plan.outputs, referenceFile], { encoding: "utf8", timeout: 7200000, maxBuffer: 1024 * 1024 });
  if (run.error || run.status !== 0 || run.stderr?.trim()) throw Error("Independent video transform could not be reproduced");
  fs.chmodSync(referenceFile, 0o600);
  const reference = inspectStreams(referenceFile, tools.ffprobe);
  assert.deepEqual(candidate, reference, "Final stream configuration differs from independent transform");
  const referenceMedia = inspectMedia(referenceFile, tools.ffprobe), candidateMedia = inspectMedia(request.candidateFile, tools.ffprobe);
  assert.deepEqual(candidateMedia.chapters, referenceMedia.chapters, "Final chapters differ from independent transform");
  assert.deepEqual(candidateMedia.format?.tags, referenceMedia.format?.tags, "Final global tags differ from independent transform");
  const referencePackets = reference.map((stream, index) => {
    const chapter = verifyChapterCarrier(referenceMedia, candidateMedia, stream, candidate[index], { numerator: "0", denominator: "1" });
    if (chapter) return { index, ...chapter };
    const shift = copiedVideoShift(framehash(referenceFile, `0:${stream.index}`, "copy", tools.ffmpeg, directory),
      framehash(request.candidateFile, `0:${candidate[index].index}`, "copy", tools.ffmpeg, directory));
    if (shift.numerator !== 0n) throw Error("Independent transform packet timestamps differ");
    return { index, status: "pass" };
  });
  let offset = null;
  const videos = sourceVideo.map((stream, index) => {
    const actual = candidateVideo[index];
    if (stream.codec_name !== "hevc" && (["smpte2084", "arib-std-b67"].includes(stream.color_transfer)
        || (stream.side_data_list || []).length)) throw Error("HDR/side-data video conversion lacks an independently admitted carrier transform");
    assert.deepEqual(videoProperties(actual), videoProperties(stream), "Video native pixels, geometry, color or HDR metadata changed");
    if (actual.codec_name !== "hevc") throw Error("Video stage did not produce the intended HEVC codec");
    const decoded = (file, video) => framehash(file, `0:v:${index}`, "rawvideo", tools.ffmpeg, directory, video);
    // Independently reproduced pixels are mandatory even for a lossy transform.
    const referenceShift = copiedVideoShift(decoded(referenceFile, actual), decoded(request.candidateFile, actual));
    if (referenceShift.numerator !== 0n) throw Error("Independent video decoded pixels or timestamps differ");
    const compare = stream.codec_name === "hevc" ? copiedVideoShift : transformedVideoShift;
    const shift = compare(decoded(request.sourceFile, stream), decoded(request.candidateFile, actual));
    if (stream.codec_name === "hevc") {
      const packetShift = copiedVideoShift(framehash(request.sourceFile, `0:v:${index}`, "copy", tools.ffmpeg, directory),
        framehash(request.candidateFile, `0:v:${index}`, "copy", tools.ffmpeg, directory));
      if (!sameOffset(packetShift, shift)) throw Error("Copied video packet and decoded frame clocks disagree");
    }
    if (offset && !sameOffset(offset, shift)) throw Error("Video streams have independent timeline shifts");
    offset = shift;
    return { index, status: "pass", kind: stream.codec_name === "hevc" ? "copy" : "hevc_nvenc" };
  });
  const audioMap = source.filter(stream => stream.type === "audio").map((stream, index) => ({ id: `video-a${index}`,
    sourceIndex: index, candidateIndex: index, channels: Number(stream.channels), rate: Number(stream.sample_rate), sampleBytes: 8, compareSamples: true }));
  const preserved = preserveVideoAudio(request, source, candidate, audioMap, offset, directory, tools);
  const spec = { sourceFile: request.sourceFile, candidateFile: preserved.output, sourceStreams: source,
    candidateStreams: inspectStreams(preserved.output, tools.ffprobe), audioMap, ffmpegPath: tools.ffmpeg, ffprobePath: tools.ffprobe, directory };
  const clock = verifyMappedAudioClocks(spec, offset);
  const copiedAudio = await verifyCopiedAudio(spec);
  const errors = [...clock.errors, ...copiedAudio.flatMap(item => item.errors)];
  const metadata = verifyMetadataCarriers(inspectMedia(request.sourceFile, tools.ffprobe), inspectMedia(preserved.output, tools.ffprobe),
    { numerator: String(offset.numerator), denominator: String(offset.denominator) });
  return { reference: { file: referenceFile, identity: fileDigest(referenceFile), plan }, referencePackets, videos,
    commonOffset: { numerator: String(offset.numerator), denominator: String(offset.denominator) },
    audio: clock.audio, audioWindows: preserved.windows, copiedAudio, metadata, errors, output: { file: preserved.output, identity: fileDigest(preserved.output) },
    transport: preserved.transport };
}

module.exports = { verifyVideoStage };
