"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { validateRequest } = require("./mediaClockProtocol");
const { runVerificationProcess, serveVerificationWorker } = require("./mediaVerificationProcess");
const { inspectMedia, inspectStreams } = require("./mediaSourceProbe");
const { verifyClockFiles, verifyVideoClocks, createEvidenceCache, prewarmClockEvidence } = require("./mediaClockVerification");
const { probeAudioTimeline } = require("./mediaNativeAudioClock");
const { planAacClock, planNormalizedAacClock, encodeClockPlan } = require("./audioClockPlan");
const { audioPresentation } = require("./mediaAudioWindow");
const { readNormalizedEofContextForWorker, assertAudioMapMatchesEofContext, usesNormalizedEof, resolveNormalizedEofCounts } = require("./mediaAudioEofContext");
const { decoderIdentity } = require("./mediaEvidenceTools");
const { fileDigest, fileDigestAsync, writePrivateReceipt } = require("./mediaEvidenceFiles");
const { moduleEvidence } = require("./mediaReferenceProof");
const { finishProducer } = require("./mediaStageProducer");
const { snapshotCarrier, runCarrier } = require("./mediaTransportCarrier");
const { verifyTransportOutput } = require("./mediaAudioTransportEvidence");
const { SCHEMA, SCOPE, validateTransportReceipt } = require("./mediaAudioTransportProtocol");
require("./mediaClockWorker");

function transportPlans(spec, offset, ffprobe) {
  const source = spec.sourceStreams.filter(stream => stream.type === "audio");
  const candidate = spec.candidateStreams.filter(stream => stream.type === "audio");
  assert.equal(candidate.length, spec.audioMap.length);
  const presentation = audioPresentation(spec.candidateFile);
  assert.equal(presentation.tracks.length, candidate.length);
  const sourceTick = spec.sourceClockTick
    ? { numerator: BigInt(spec.sourceClockTick.numerator), denominator: BigInt(spec.sourceClockTick.denominator) } : null;
  const timelines = new Map();
  return spec.audioMap.map(map => {
    const stream = candidate[map.candidateIndex];
    assert.ok(source[map.sourceIndex] && stream?.codec_name === "aac" && Number(stream.channels) === map.channels,
      "Clock carrier requires complete mapped AAC output streams");
    if (!timelines.has(map.sourceIndex)) timelines.set(map.sourceIndex,
      probeAudioTimeline(spec.sourceFile, map.sourceIndex, source[map.sourceIndex], ffprobe, spec.directory, sourceTick, spec.evidenceCache));
    const sourceTimeline = timelines.get(map.sourceIndex);
    const input = probeAudioTimeline(spec.candidateFile, map.candidateIndex, stream, ffprobe, spec.directory, null, spec.evidenceCache);
    const window = presentation.tracks[map.candidateIndex];
    const eofEntry = spec.eofContext?.streams?.[map.candidateIndex];
    if (usesNormalizedEof(eofEntry, sourceTimeline)) {
      const domain = resolveNormalizedEofCounts(eofEntry, sourceTimeline.samples);
      const originalEnd = eofEntry.originalWindow.window.declaredEnd;
      const { plan, declaredEnd } = planNormalizedAacClock(sourceTimeline, input, offset, {
        counts: domain, originalEnd, candidateWindow: window,
      });
      return {
        streamIndex: stream.index, plan, durationRuns: window.durationRuns, declaredEnd,
        normalizedEof: { validSamples: String(domain.validSamples), decodedSamples: String(domain.decodedSamples),
          paddingSamples: String(domain.paddingSamples), originalEnd },
      };
    }
    return { streamIndex: stream.index, plan: planAacClock(sourceTimeline, input, offset),
      durationRuns: window.durationRuns, declaredEnd: window.declaredEnd };
  });
}

async function transportRequest(request) {
  validateRequest(request);
  const producer = moduleEvidence([module.filename]);
  const directory = fs.mkdtempSync(path.join(request.directory, ".media-transport-"));
  const decoder = decoderIdentity(request.ffmpegPath), prober = decoderIdentity(request.ffprobePath);
  const tools = { ffmpeg: (decoder.native || decoder).executable, ffprobe: (prober.native || prober).executable };
  const inputFiles = [...new Set([request.sourceFile, request.candidateFile])];
  const inputsPromise = Promise.all(inputFiles.map(async file => ({ file, identity: await fileDigestAsync(file) })));
  const errors = [], result = { operation: "unchanged", output: null,
    carrier: null, plans: [], values: [] };
  const evidenceCache = createEvidenceCache(directory);
  let inputs = null;
  try {
    const sourceStreams = inspectStreams(request.sourceFile, tools.ffprobe), candidateStreams = inspectStreams(request.candidateFile, tools.ffprobe);
    const audio = candidateStreams.filter(stream => stream.type === "audio");
    const audioMap = request.audioMap.map(map => ({ ...map, rate: map.rate ?? Number(audio[map.candidateIndex]?.sample_rate) }));
    const eofContext = Object.hasOwn(request, "eofContext") ? readNormalizedEofContextForWorker(request.eofContext, {
      sourceFile: request.sourceFile, directory: request.directory, decoder, prober, ffprobePath: request.ffprobePath,
    }) : null;
    if (eofContext) {
      assert.equal(eofContext.candidate.file, request.candidateFile, "Normalized EOF context candidate differs from transport input");
      assertAudioMapMatchesEofContext(audioMap, eofContext);
    }
    const spec = { ...request, directory, sourceStreams, candidateStreams, audioMap, eofContext, ffmpegPath: tools.ffmpeg, ffprobePath: tools.ffprobe,
      evidenceCache, deferPostDigest: true };
    const [resolvedInputs] = await Promise.all([inputsPromise, prewarmClockEvidence(spec, evidenceCache)]);
    inputs = resolvedInputs;
    result.output = inputs.find(item => item.file === request.candidateFile);
    spec.initialDigests = new Map(inputs.map(item => [item.file, item.identity]));
    result.clock = verifyClockFiles(spec);
    if (result.clock.errors.length) {
      const format = String(inspectMedia(request.candidateFile, tools.ffprobe).format?.format_name || "");
      assert.ok(format.split(",").includes("mov"), result.clock.errors.join("; "));
      const video = verifyVideoClocks(spec); assert.deepEqual(video.errors, [], "Copied video cannot be repaired by audio transport");
      const available = fs.statfsSync(directory, { bigint: true });
      const required = BigInt(result.output.identity.bytes) * 2n + 67108864n;
      assert.ok(available.bavail * available.bsize >= required, "Insufficient capacity for audio clock transport");
      result.carrier = snapshotCarrier(directory); result.plans = transportPlans(spec, video.offset, tools.ffprobe);
      const plan = path.join(directory, "clock.txt");
      fs.writeFileSync(plan, encodeClockPlan(result.plans), { flag: "wx", mode: 0o600 });
      result.plan = { file: plan, identity: fileDigest(plan) };
      const output = path.join(path.dirname(request.candidateFile), `.audio-clock-${randomUUID()}.mp4`);
      runCarrier(result.carrier, request.candidateFile, output, plan);
      const verified = await verifyTransportOutput(spec, output, result.plans, tools);
      const outputIdentity = verified.clock.inputs.find(item => item.file === output)?.identity || fileDigest(output);
      Object.assign(result, verified, { operation: "retimed", output: { file: output, identity: outputIdentity } });
      assert.deepEqual(fileDigest(plan), result.plan.identity, "Clock plan changed during transport");
    }
  } catch (error) { errors.push(String(error.message).slice(0, 1024)); }
  finally { evidenceCache.dispose(); }
  if (!inputs) {
    inputs = await inputsPromise;
    result.output = inputs.find(item => item.file === request.candidateFile);
  }
  const postDigests = await Promise.all(inputs.map(input => fileDigestAsync(input.file)));
  for (let index = 0; index < inputs.length; index++) {
    if (JSON.stringify(postDigests[index]) !== JSON.stringify(inputs[index].identity)) errors.push("Transport input changed");
  }
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
