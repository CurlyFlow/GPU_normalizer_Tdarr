"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { validateRequest } = require("./mediaClockProtocol");
const { runVerificationProcess, serveVerificationWorker } = require("./mediaVerificationProcess");
const { inspectStreams } = require("./mediaSourceProbe");
const { verifyClockFiles, verifyVideoClocks } = require("./mediaClockVerification");
const { probeAudioTimeline } = require("./mediaNativeAudioClock");
const { planAacClock, encodeClockPlan } = require("./audioClockPlan");
const { audioPresentation } = require("./mediaAudioWindow");
const { decoderIdentity } = require("./mediaEvidenceTools");
const { fileDigest, writePrivateReceipt } = require("./mediaEvidenceFiles");
const { moduleEvidence } = require("./mediaReferenceProof");
const { finishProducer } = require("./mediaStageProducer");
const { snapshotCarrier, runCarrier } = require("./mediaTransportCarrier");
const { verifyTransportOutput } = require("./mediaAudioTransportEvidence");
const { SCHEMA, SCOPE, validateTransportReceipt } = require("./mediaAudioTransportProtocol");

function transportPlans(spec, offset, ffprobe) {
  const source = spec.sourceStreams.filter(stream => stream.type === "audio");
  const candidate = spec.candidateStreams.filter(stream => stream.type === "audio");
  assert.equal(candidate.length, spec.audioMap.length);
  const presentation = audioPresentation(spec.candidateFile);
  assert.equal(presentation.tracks.length, candidate.length);
  const timelines = new Map();
  return spec.audioMap.map(map => {
    const stream = candidate[map.candidateIndex];
    assert.ok(source[map.sourceIndex] && stream?.codec_name === "aac" && Number(stream.channels) === map.channels,
      "Clock carrier requires complete mapped AAC output streams");
    if (!timelines.has(map.sourceIndex)) timelines.set(map.sourceIndex,
      probeAudioTimeline(spec.sourceFile, map.sourceIndex, source[map.sourceIndex], ffprobe, spec.directory));
    const input = probeAudioTimeline(spec.candidateFile, map.candidateIndex, stream, ffprobe, spec.directory);
    const window = presentation.tracks[map.candidateIndex];
    return { streamIndex: stream.index, plan: planAacClock(timelines.get(map.sourceIndex), input, offset),
      durationRuns: window.durationRuns, declaredEnd: window.declaredEnd };
  });
}

async function transportRequest(request) {
  validateRequest(request);
  const producer = moduleEvidence([module.filename]);
  const directory = fs.mkdtempSync(path.join(request.directory, ".media-transport-"));
  const decoder = decoderIdentity(request.ffmpegPath), prober = decoderIdentity(request.ffprobePath);
  const tools = { ffmpeg: (decoder.native || decoder).executable, ffprobe: (prober.native || prober).executable };
  const inputs = [...new Set([request.sourceFile, request.candidateFile])].map(file => ({ file, identity: fileDigest(file) }));
  const errors = [], result = { operation: "unchanged", output: inputs.find(item => item.file === request.candidateFile),
    carrier: null, plans: [], values: [] };
  try {
    const sourceStreams = inspectStreams(request.sourceFile, tools.ffprobe), candidateStreams = inspectStreams(request.candidateFile, tools.ffprobe);
    const audio = candidateStreams.filter(stream => stream.type === "audio");
    const audioMap = request.audioMap.map(map => ({ ...map, rate: map.rate ?? Number(audio[map.candidateIndex]?.sample_rate) }));
    const spec = { ...request, directory, sourceStreams, candidateStreams, audioMap, ffmpegPath: tools.ffmpeg, ffprobePath: tools.ffprobe };
    result.clock = verifyClockFiles(spec);
    if (result.clock.errors.length) {
      const video = verifyVideoClocks(spec); assert.deepEqual(video.errors, [], "Copied video cannot be repaired by audio transport");
      const available = fs.statfsSync(directory, { bigint: true });
      const required = BigInt(fileDigest(request.candidateFile).bytes) * 2n + 67108864n;
      assert.ok(available.bavail * available.bsize >= required, "Insufficient capacity for audio clock transport");
      result.carrier = snapshotCarrier(directory); result.plans = transportPlans(spec, video.offset, tools.ffprobe);
      const plan = path.join(directory, "clock.txt");
      fs.writeFileSync(plan, encodeClockPlan(result.plans), { flag: "wx", mode: 0o600 });
      result.plan = { file: plan, identity: fileDigest(plan) };
      const output = path.join(path.dirname(request.candidateFile), `.audio-clock-${randomUUID()}.mp4`);
      runCarrier(result.carrier, request.candidateFile, output, plan);
      Object.assign(result, await verifyTransportOutput(spec, output, result.plans, tools),
        { operation: "retimed", output: { file: output, identity: fileDigest(output) } });
      assert.deepEqual(fileDigest(plan), result.plan.identity, "Clock plan changed during transport");
    }
  } catch (error) { errors.push(String(error.message).slice(0, 1024)); }
  for (const input of inputs) if (JSON.stringify(fileDigest(input.file)) !== JSON.stringify(input.identity)) errors.push("Transport input changed");
  for (const artifact of [result.carrier?.installed, result.carrier?.snapshot, result.plan].filter(Boolean)) {
    if (JSON.stringify(fileDigest(artifact.file)) !== JSON.stringify(artifact.identity)) errors.push("Transport artifact changed");
  }
  if (JSON.stringify(decoderIdentity(request.ffmpegPath)) !== JSON.stringify(decoder)
      || JSON.stringify(decoderIdentity(request.ffprobePath)) !== JSON.stringify(prober)) errors.push("Transport tools changed");
  const receipt = writePrivateReceipt(directory, "media-transport-receipt", { schema: SCHEMA, scope: SCOPE,
    status: errors.length ? "held" : "pass", errors, request, inputs, ...result, decoder, prober,
    producer: finishProducer(producer, module.filename), workerPid: process.pid });
  validateTransportReceipt(receipt, request);
  return receipt;
}

async function transportAudioInWorker(request, options) {
  return await runVerificationProcess(path.join(__dirname, "mediaAudioTransportWorker.js"), request, validateTransportReceipt, options);
}

serveVerificationWorker(module, transportRequest);
module.exports = { transportAudioInWorker };
