"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { runVerificationProcess, serveVerificationWorker } = require("./mediaVerificationProcess");
const { fileDigest } = require("./mediaEvidenceFiles");
const { decoderIdentity } = require("./mediaEvidenceTools");
const { verifyAudioValueMap, recompareAudioValueMap } = require("./mediaAudioReference");
const { readAudioValueBasis } = require("./mediaAudioValueBasis");
const { moduleEvidence } = require("./mediaReferenceProof");
const { finishProducer } = require("./mediaStageProducer");
const { SCHEMA, SCOPE, validateValueRequest, validateValueReceipt } = require("./mediaAudioValueProtocol");

async function verifyValues(request) {
  validateValueRequest(request);
  const producer = moduleEvidence([module.filename]);
  const directory = fs.mkdtempSync(path.join(request.directory, ".media-values-"));
  const decoder = decoderIdentity(request.ffmpegPath), prober = decoderIdentity(request.ffprobePath);
  const tools = { ffmpeg: (decoder.native || decoder).executable, ffprobe: (prober.native || prober).executable };
  const inputs = [...new Set([request.sourceFile, request.candidateFile])].map(file => ({ file, identity: fileDigest(file) }));
  const basis = readAudioValueBasis(request);
  if (basis) {
    assert.deepEqual(basis.decoder, decoder, "Audio comparison basis decoder changed");
    assert.deepEqual(basis.prober, prober, "Audio comparison basis prober changed");
  }
  const results = [];
  for (const map of request.maps) {
    const owned = path.join(directory, map.id);
    fs.mkdirSync(owned, { mode: 0o700 });
    results.push(basis ? await recompareAudioValueMap(request, map, basis.results[map.candidateIndex], tools)
      : await verifyAudioValueMap(request, map, owned, tools));
  }
  const errors = results.flatMap(result => result.errors.map(error => `${result.id}: ${error}`));
  if (inputs.some(input => JSON.stringify(fileDigest(input.file)) !== JSON.stringify(input.identity))) errors.push("Audio input changed during value verification");
  if (JSON.stringify(decoderIdentity(request.ffmpegPath)) !== JSON.stringify(decoder)
       || JSON.stringify(decoderIdentity(request.ffprobePath)) !== JSON.stringify(prober)) errors.push("Audio verification tool changed");
  if (basis) readAudioValueBasis(request);
  const receipt = { schema: SCHEMA, scope: SCOPE, status: errors.length ? "held" : "pass", errors,
    request, inputs, results, decoder, prober, producer: finishProducer(producer, module.filename), workerPid: process.pid, receiptPath: path.join(directory, "receipt.json") };
  validateValueReceipt(receipt, request);
  fs.writeFileSync(receipt.receiptPath, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
  return receipt;
}

async function verifyAudioValuesInWorker(request, options) {
  return await runVerificationProcess(path.join(__dirname, "mediaAudioValueWorker.js"), request, validateValueReceipt, options);
}

serveVerificationWorker(module, verifyValues);

module.exports = { verifyAudioValuesInWorker };
