"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { readRetainedReceipt } = require("./mediaEvidenceFiles");
const SCHEMA = "media-finish-integrity.v1";
const SCOPE = "admitted-original-intended-transformations";

function canonical(file) {
  return typeof file === "string" && !file.includes("\0") && path.isAbsolute(file)
    && path.resolve(file) === file && fs.realpathSync(file) === file;
}

function validateFinishRequest(request) {
  const keys = "audioFile,audioIntent,candidateFile,completedRoot,directory,ffmpegPath,ffprobePath,libraryId,originalFile,preparation,preparedFile,settings,stagingRoot,stateRoot,videos";
  if (!request || Object.keys(request).sort().join() !== keys
      || !["originalFile", "preparedFile", "audioFile", "candidateFile", "stagingRoot", "completedRoot", "stateRoot", "directory"]
        .every(key => canonical(request[key])) || request.originalFile === request.candidateFile
      || typeof request.libraryId !== "string" || !request.libraryId
      || ![request.ffmpegPath, request.ffprobePath].every(value => typeof value === "string" && value.trim() && !value.includes("\0"))
      || !Array.isArray(request.videos) || request.videos.length < 1 || request.videos.length > 2) throw Error("Invalid complete finish request");
  if (path.dirname(request.originalFile) !== request.stagingRoot && !request.originalFile.startsWith(`${request.stagingRoot}${path.sep}`)) {
    throw Error("Admitted original is outside its staging scope");
  }
}

function validateFinishReceipt(value, request) {
  if (!value || value.schema !== SCHEMA || value.scope !== SCOPE || JSON.stringify(value.request) !== JSON.stringify(request)
      || !["pass", "held"].includes(value.status) || !Array.isArray(value.errors)
      || (value.status === "pass") !== (value.errors.length === 0) || !Array.isArray(value.inputs)
      || value.inputs.length > 4096 || new Set(value.inputs.map(input => input.file)).size !== value.inputs.length) {
    throw Error("Invalid complete finish receipt");
  }
  value.inputs.forEach(input => {
    if (typeof input.file !== "string" || !/^[a-f0-9]{64}$/.test(input.identity?.sha256)
        || !Number.isSafeInteger(input.identity.bytes) || input.identity.bytes < 1
        || !/^\d+:\d+:\d+:-?\d+:-?\d+$/.test(input.identity.stamp)) throw Error("Incomplete finish generation");
  });
  if (value.status !== "pass") return;
  if ([request.originalFile, request.preparedFile, request.audioFile, request.candidateFile].some(file => !value.inputs.some(input => input.file === file))
      || value.coverage?.status !== "pass" || value.coverage.preparation?.metadata?.status !== "pass"
      || value.coverage.audio?.metadata?.status !== "pass" || !Array.isArray(value.coverage.videos)
      || value.coverage.videos.length !== request.videos.length || value.coverage.videos.some(item => item.status !== "pass")
      || !value.producer?.modules?.length || !value.decoder || !value.prober) throw Error("Incomplete admitted-original finish acceptance");
  const preparation = readRetainedReceipt(request.preparation);
  assert.ok(preparation.sourceInput?.file === preparation.mapping?.sourceId, "Missing preparation source generation");
  assert.deepEqual(value.inputs.find(input => input.file === preparation.sourceInput.file), preparation.sourceInput,
    "Missing admitted preparation source generation");
  const subtitles = preparation.actual?.subtitles;
  if (!Array.isArray(subtitles) || subtitles.length > 256) throw Error("Missing admitted subtitle inventory");
  assert.deepEqual(value.coverage.preparation.extractions, subtitles.map(record => ({ ...record, status: "pass" })),
    "Incomplete subtitle extraction acceptance");
  for (const { file, identity } of subtitles) {
    assert.deepEqual(value.inputs.find(input => input.file === file), { file, identity }, "Missing admitted subtitle generation");
  }
}

module.exports = { SCHEMA, SCOPE, validateFinishRequest, validateFinishReceipt };
