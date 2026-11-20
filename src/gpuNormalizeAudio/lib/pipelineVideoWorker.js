"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { runVerificationProcess, serveVerificationWorker } = require("./mediaVerificationProcess");
const { decoderIdentity } = require("./mediaEvidenceTools");
const { fileDigest } = require("./mediaEvidenceFiles");
const { verifyVideoStage } = require("./pipelineVideoEvidence");
const { moduleEvidence } = require("./mediaReferenceProof");
const { finishProducer } = require("./mediaStageProducer");
const { SCHEMA, SCOPE, validateVideoRequest, validateVideoReceipt } = require("./pipelineVideoProtocol");

async function verifyRequest(request) {
  validateVideoRequest(request);
  const producer = moduleEvidence([module.filename]);
  const directory = fs.mkdtempSync(path.join(request.directory, ".media-video-"));
  const decoder = decoderIdentity(request.ffmpegPath), prober = decoderIdentity(request.ffprobePath);
  const files = [...new Set([request.sourceFile, request.candidateFile, ...request.sidecars.map(sidecar => sidecar.file)])];
  const inputs = files.map(file => ({ file, identity: fileDigest(file) }));
  let proof = { errors: [] };
  try {
    proof = await verifyVideoStage(request, directory, { ffmpeg: (decoder.native || decoder).executable,
      ffprobe: (prober.native || prober).executable });
  } catch (error) { proof.errors.push(error.message); }
  for (const artifact of [proof.output, proof.transport?.carrier.installed, proof.transport?.carrier.snapshot, proof.transport?.plan].filter(Boolean)) {
    if (JSON.stringify(fileDigest(artifact.file)) !== JSON.stringify(artifact.identity)) proof.errors.push("Video transport generation changed");
  }
  for (const input of inputs) {
    if (JSON.stringify(fileDigest(input.file)) !== JSON.stringify(input.identity)) proof.errors.push("Video stage input changed during verification");
  }
  if (JSON.stringify(decoderIdentity(request.ffmpegPath)) !== JSON.stringify(decoder)
      || JSON.stringify(decoderIdentity(request.ffprobePath)) !== JSON.stringify(prober)) proof.errors.push("Video reference tool changed");
  const receipt = { schema: SCHEMA, scope: SCOPE, request, ...proof, status: proof.errors.length ? "held" : "pass",
    inputs, decoder, prober, producer: finishProducer(producer, module.filename), workerPid: process.pid, receiptPath: path.join(directory, "receipt.json") };
  validateVideoReceipt(receipt, request);
  fs.writeFileSync(receipt.receiptPath, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
  return receipt;
}

async function verifyVideoInWorker(request, options) {
  return await runVerificationProcess(path.join(__dirname, "pipelineVideoWorker.js"), request, validateVideoReceipt, options);
}

serveVerificationWorker(module, verifyRequest);

module.exports = { verifyVideoInWorker };
