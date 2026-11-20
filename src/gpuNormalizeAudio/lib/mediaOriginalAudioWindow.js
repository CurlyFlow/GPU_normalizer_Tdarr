"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sourceProbe = require("./mediaSourceProbe");
const { decoderIdentity } = require("./mediaEvidenceTools");
const { fileDigest, sameFileGeneration } = require("./mediaEvidenceFiles");
const { storedAudioPresentation } = require("./mediaAudioWindow");

// Observation only. The caller must bind this file and ordinal to the admitted
// original; a prepared remux or a self-declared path is not that authority.
function observeOriginalAudioWindow(file, audioIndex, ffprobePath) {
  assert.ok(typeof file === "string" && !file.includes("\0") && path.isAbsolute(file)
    && path.resolve(file) === file && fs.realpathSync(file) === file, "Original audio path is not canonical");
  assert.ok(Number.isSafeInteger(audioIndex) && audioIndex >= 0 && audioIndex < 256, "Invalid original audio ordinal");
  const prober = decoderIdentity(ffprobePath), identity = fileDigest(file);
  const unchanged = () => assert.ok(sameFileGeneration(identity, fileDigest(file)), "Original audio window input changed");
  const media = sourceProbe.inspectMedia(file, (prober.native || prober).executable);
  unchanged();
  const format = media.format?.format_name;
  assert.ok(typeof format === "string" && format.split(",").includes("mov"), "Unsupported original presentation format");
  const audio = media.streams.filter(stream => stream.codec_type === "audio"), stream = audio[audioIndex];
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

module.exports = { observeOriginalAudioWindow };
