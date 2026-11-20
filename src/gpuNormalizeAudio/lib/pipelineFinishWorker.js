"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { runVerificationProcess, serveVerificationWorker } = require("./mediaVerificationProcess");
const { fileDigest, sameFileGeneration, writePrivateReceipt } = require("./mediaEvidenceFiles");
const { decoderIdentity } = require("./mediaEvidenceTools");
const { moduleEvidence } = require("./mediaReferenceProof");
const { finishProducer } = require("./mediaStageProducer");
const { verifyFinishChain } = require("./pipelineFinishChain");
const { finishInputs } = require("./pipelineFinishInputs");
const { verifyFinishCarriers } = require("./pipelineFinishCarriers");
const { SCHEMA, SCOPE, validateFinishRequest, validateFinishReceipt } = require("./pipelineFinishProtocol");

async function verifyRequest(request) {
  validateFinishRequest(request);
  const producer = moduleEvidence([module.filename]);
  const directory = fs.mkdtempSync(path.join(request.directory, ".media-finish-work-"));
  const decoder = decoderIdentity(request.ffmpegPath), prober = decoderIdentity(request.ffprobePath);
  const tools = { ffmpeg: (decoder.native || decoder).executable, ffprobe: (prober.native || prober).executable, decoder, prober };
  let inputs = [...new Set([request.originalFile, request.preparedFile, request.audioFile, request.candidateFile])]
    .map(file => ({ file, identity: fileDigest(file) }));
  let coverage = null;
  const errors = [];
  try {
    const chain = verifyFinishChain(request, tools);
    const admitted = finishInputs(request, chain);
    if (inputs.some(input => !admitted.some(other => other.file === input.file && sameFileGeneration(input.identity, other.identity)))) {
      throw Error("Finish input changed before complete comparison");
    }
    inputs = admitted;
    coverage = verifyFinishCarriers(request, chain, tools, directory);
    inputs.forEach(input => { if (!sameFileGeneration(input.identity, fileDigest(input.file))) throw Error("Finish input changed during complete comparison"); });
    assert.deepEqual(decoderIdentity(request.ffmpegPath), decoder, "Finish decoder changed");
    assert.deepEqual(decoderIdentity(request.ffprobePath), prober, "Finish prober changed");
  } catch (error) { errors.push(error.message.slice(0, 1024)); }
  const receipt = writePrivateReceipt(request.directory, "media-finish", {
    schema: SCHEMA, scope: SCOPE, status: errors.length ? "held" : "pass", errors,
    request, inputs, coverage, decoder, prober, producer: finishProducer(producer, module.filename), workerPid: process.pid });
  validateFinishReceipt(receipt, request);
  return receipt;
}

async function verifyFinishInWorker(request, options) {
  return await runVerificationProcess(path.join(__dirname, "pipelineFinishWorker.js"), request, validateFinishReceipt, options);
}

serveVerificationWorker(module, verifyRequest);

module.exports = { verifyFinishInWorker };
