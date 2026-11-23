"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sourceProbe = require("./mediaSourceProbe");
const { decoderIdentity } = require("./mediaEvidenceTools");
const { fileDigest, sameFileGeneration } = require("./mediaEvidenceFiles");
const { storedAudioPresentation } = require("./mediaAudioWindow");
const { probeAudioTimeline } = require("./mediaNativeAudioClock");

function rationalGcd(a, b) {
  let x = a < 0n ? -a : a, y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x || 1n;
}

function openOriginalAudio(file, audioIndex, ffprobePath) {
  assert.ok(typeof file === "string" && !file.includes("\0") && path.isAbsolute(file)
    && path.resolve(file) === file && fs.realpathSync(file) === file, "Original audio path is not canonical");
  assert.ok(Number.isSafeInteger(audioIndex) && audioIndex >= 0 && audioIndex < 256, "Invalid original audio ordinal");
  const prober = decoderIdentity(ffprobePath), identity = fileDigest(file);
  const unchanged = () => assert.ok(sameFileGeneration(identity, fileDigest(file)), "Original audio window input changed");
  const ffprobeExec = (prober.native || prober).executable;
  const media = sourceProbe.inspectMedia(file, ffprobeExec);
  unchanged();
  const format = media.format?.format_name;
  const formats = typeof format === "string" ? format.split(",") : [];
  const audio = media.streams.filter(stream => stream.codec_type === "audio"), stream = audio[audioIndex];
  return { prober, identity, unchanged, ffprobeExec, format, formats, audio, stream };
}

// Observation only. The caller must bind this file and ordinal to the admitted
// original; a prepared remux or a self-declared path is not that authority.
function observeOriginalAudioWindow(file, audioIndex, ffprobePath) {
  const { prober, identity, unchanged, format, formats, audio, stream } = openOriginalAudio(file, audioIndex, ffprobePath);
  assert.ok(formats.includes("mov"), "Unsupported original presentation format");
  assert.ok(stream, "Missing original audio ordinal");
  assert.equal(stream.codec_name, "aac", "Unsupported original audio window codec");
  assert.ok(Number.isSafeInteger(stream.index) && stream.index >= 0
    && Number.isSafeInteger(Number(stream.sample_rate)) && Number(stream.sample_rate) > 0, "Invalid original audio identity");
  const tables = storedAudioPresentation(file);
  assert.equal(tables.tracks.length, audio.length, "Original audio window coverage differs");
  assert.deepEqual(decoderIdentity(ffprobePath), prober, "Original audio window prober changed");
  unchanged();
  return { schema: "media-original-audio-window.v1", scope: "observed-iso-aac-window-only", file, identity,
    audioIndex, streamIndex: stream.index, sampleRate: Number(stream.sample_rate), format,
    window: tables.tracks[audioIndex], prober };
}

function observeNativeAudioWindow(file, audioIndex, ffprobePath, directory) {
  const { prober, identity, unchanged, ffprobeExec, format, formats, stream } = openOriginalAudio(file, audioIndex, ffprobePath);
  assert.ok(formats.includes("mov") || formats.includes("matroska"), "Unsupported original presentation format");
  assert.ok(stream, "Missing original audio ordinal");
  if (formats.includes("mov") && stream.codec_name === "aac") {
    return observeOriginalAudioWindow(file, audioIndex, ffprobePath);
  }
  assert.ok(Number.isSafeInteger(stream.index) && stream.index >= 0
    && Number.isSafeInteger(Number(stream.sample_rate)) && Number(stream.sample_rate) > 0, "Invalid original audio identity");
  const timeline = probeAudioTimeline(file, audioIndex, stream, ffprobeExec, directory);
  const last = timeline.segments.at(-1), tail = timeline.samples - last.samples, rate = BigInt(timeline.rate);
  const rawNum = last.start.numerator * rate + tail * last.start.denominator, rawDen = last.start.denominator * rate;
  const divisor = rationalGcd(rawNum, rawDen);
  const declaredEnd = { numerator: String(rawNum / divisor), denominator: String(rawDen / divisor) };
  assert.deepEqual(decoderIdentity(ffprobePath), prober, "Original audio window prober changed");
  unchanged();
  return { schema: "media-original-audio-window.v1", scope: "observed-native-timeline-window-only", file, identity,
    audioIndex, streamIndex: stream.index, sampleRate: Number(stream.sample_rate), format,
    window: { rate: String(timeline.rate), samples: String(timeline.samples), declaredEnd }, prober };
}

module.exports = { observeOriginalAudioWindow, observeNativeAudioWindow };
