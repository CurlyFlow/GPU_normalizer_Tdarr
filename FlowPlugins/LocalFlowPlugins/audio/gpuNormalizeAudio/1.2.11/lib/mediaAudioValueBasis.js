"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fileDigest, sameFileGeneration, readRetainedReceipt } = require("./mediaEvidenceFiles");
const { validateValueReceipt, normalizesAudio } = require("./mediaAudioValueProtocol");
const { audioReferenceInputs } = require("./mediaAudioReference");
const { requireStageProducer } = require("./mediaStageProducer");

function readAudioValueBasis(request, renamed = null) {
  if (!Object.hasOwn(request, "basis")) return null;
  const previous = readRetainedReceipt(request.basis);
  assert.ok(!Object.hasOwn(previous.request, "basis"), "Audio comparison basis cannot chain");
  validateValueReceipt(previous, previous.request);
  assert.equal(previous.status, "pass", "Audio comparison basis is not successful");
  assert.equal(previous.receiptPath, request.basis.file, "Audio comparison basis path changed");
  for (const key of ["sourceFile", "directory", "ffmpegPath", "ffprobePath", "maps", "plugin"]) {
    assert.deepEqual(previous.request[key], request[key], "Audio comparison basis differs from this execution");
  }
  assert.notEqual(previous.request.sourceFile, previous.request.candidateFile);
  assert.notEqual(request.sourceFile, request.candidateFile);
  for (const file of [previous.request.candidateFile, request.candidateFile]) {
    assert.ok(file.startsWith(request.directory + path.sep), "Audio candidate is outside this execution");
  }
  requireStageProducer(previous, "./mediaAudioValueWorker");
  const source = previous.inputs.find(input => input.file === request.sourceFile);
  for (const result of previous.results) {
    if (normalizesAudio(result)) {
      const environment = result.reference.inputs.reference_inputs;
      assert.equal(environment.source_file, source.file);
      assert.deepEqual(environment.source, source.identity, "CPU reference source generation changed");
    }
  }
  for (const input of [...previous.inputs, ...previous.results.flatMap(audioReferenceInputs)]) {
    if (renamed && input.file === previous.request.candidateFile && input.file === request.candidateFile) {
      assert.equal(renamed.from, input.file);
      assert.equal(path.dirname(renamed.from), path.dirname(renamed.to));
      assert.ok(!fs.existsSync(renamed.from) && fs.realpathSync(renamed.to) === renamed.to);
      assert.ok(sameFileGeneration(input.identity, fileDigest(renamed.to), true), "Audio basis rename generation changed");
    } else {
      assert.ok(sameFileGeneration(input.identity, fileDigest(input.file)), "Audio comparison basis generation changed");
    }
  }
  return previous;
}

function requireAudioValueBasis(value, preCandidate, renamed) {
  const previous = readAudioValueBasis(value.request, renamed);
  if (!previous) return null;
  assert.deepEqual(previous.inputs.find(input => input.file === previous.request.candidateFile), preCandidate,
    "Audio comparison basis bypasses its verified transport input");
  for (const key of ["decoder", "prober"]) assert.deepEqual(value[key], previous[key], "Audio basis tool changed");
  value.results.forEach((result, index) => {
    const original = previous.results[index];
    for (const key of ["reference", "composition", "comparisonReference"]) {
      assert.deepEqual(result[key], original[key], "Audio comparison basis reference changed");
    }
    assert.deepEqual(result.values[0].source, original.values[0].source, "Audio comparison basis values changed");
  });
  return previous;
}

module.exports = { readAudioValueBasis, requireAudioValueBasis };
