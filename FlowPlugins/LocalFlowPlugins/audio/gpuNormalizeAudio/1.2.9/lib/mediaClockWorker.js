"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { inspectMedia, inspectStreams } = require("./mediaSourceProbe");
const { runVerificationProcess, serveVerificationWorker } = require("./mediaVerificationProcess");
const { fileDigest } = require("./mediaEvidenceFiles");
const { decoderIdentity } = require("./mediaEvidenceTools");
const { verifyClockFiles, createEvidenceCache, prewarmClockEvidence } = require("./mediaClockVerification");
const { verifyCopiedAudio } = require("./mediaCopiedAudio");
const { moduleEvidence } = require("./mediaReferenceProof");
const { finishProducer } = require("./mediaStageProducer");
const { SCHEMA, SCOPE, validateRequest, validateReceipt } = require("./mediaClockProtocol");
const { readNormalizedEofContextForWorker, assertAudioMapMatchesEofContext } = require("./mediaAudioEofContext");

async function verifyRequest(request) {
  validateRequest(request);
  const producer = moduleEvidence([module.filename]);
  const directory = fs.mkdtempSync(path.join(request.directory, ".media-clock-"));
  const decoder = decoderIdentity(request.ffmpegPath), prober = decoderIdentity(request.ffprobePath);
  const native = decoder.native || decoder;
  const before = [request.sourceFile, request.candidateFile].map(file => ({ file, identity: fileDigest(file) }));
  const sourceStreams = inspectStreams(request.sourceFile, (prober.native || prober).executable);
  const candidateStreams = inspectStreams(request.candidateFile, (prober.native || prober).executable);
  const candidateAudio = candidateStreams.filter(stream => stream.type === "audio");
  // A clock-only caller may request the observed native rate. This does not
  // establish the intended encoder rate or normalized-value equality.
  const audioMap = request.audioMap.map(map => ({ ...map,
    rate: map.rate === null ? Number(candidateAudio[map.candidateIndex]?.sample_rate) : map.rate }));
  const hasEof = Object.hasOwn(request, "eofContext");
  const eofContext = hasEof ? readNormalizedEofContextForWorker(request.eofContext, {
    sourceFile: request.sourceFile, directory: request.directory, decoder, prober, ffprobePath: request.ffprobePath,
  }) : null;
  if (eofContext) assertAudioMapMatchesEofContext(audioMap, eofContext);
  const hasTick = Object.hasOwn(request, "sourceClockTick");
  const evidenceCache = createEvidenceCache(directory);
  const initialDigests = new Map(before.map(item => [item.file, item.identity]));
  let clock, clockErrors, copiedAudio;
  try {
    const clockSpec = { ...request, directory, ffmpegPath: native.executable, ffprobePath: (prober.native || prober).executable,
      sourceStreams, candidateStreams, audioMap, eofContext, sourceClockTick: hasTick ? request.sourceClockTick : null,
      evidenceCache, initialDigests, deferPostDigest: true };
    [, copiedAudio] = await Promise.all([
      prewarmClockEvidence(clockSpec, evidenceCache),
      verifyCopiedAudio({ ...request, audioMap, sourceStreams, candidateStreams, ffmpegPath: native.executable }),
    ]);
    clock = verifyClockFiles(clockSpec);
    clockErrors = [...clock.errors];
  } finally {
    evidenceCache.dispose();
  }
  clock.errors.push(...copiedAudio.flatMap(item => item.errors.map(error => `${item.map_id}: ${error}`)));
  if (before.some(input => !clock.inputs.some(actual => actual.file === input.file
      && JSON.stringify(actual.identity) === JSON.stringify(input.identity))
      || JSON.stringify(fileDigest(input.file)) !== JSON.stringify(input.identity))) clock.errors.push("Input changed during media verification");
  if (JSON.stringify(decoderIdentity(request.ffmpegPath)) !== JSON.stringify(decoder)
      || JSON.stringify(decoderIdentity(request.ffprobePath)) !== JSON.stringify(prober)) clock.errors.push("Clock verification tool changed");
  const receipt = { schema: SCHEMA, scope: SCOPE, status: clock.errors.length ? "held" : "pass", clockErrors, copiedAudio,
    sourceFile: request.sourceFile, candidateFile: request.candidateFile, audioMap,
    ...(hasEof ? { eofContext: request.eofContext } : {}),
    ...(hasTick ? { sourceClockTick: request.sourceClockTick } : {}),
    workerPid: process.pid, decoder, prober, ...clock, producer: finishProducer(producer, module.filename), receiptPath: path.join(directory, "receipt.json") };
  fs.writeFileSync(receipt.receiptPath, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
  return receipt;
}

async function verifyClockInWorker(request, options) {
  return await runVerificationProcess(path.join(__dirname, "mediaClockWorker.js"), request, validateReceipt, options);
}

serveVerificationWorker(module, verifyRequest);

// Installed stream-contract consumers also use this worker's metadata API.
module.exports = { verifyClockInWorker, inspectStreams, inspectMedia };
