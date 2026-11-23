"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { readRetainedReceipt, fileDigest, sameFileGeneration } = require("./mediaEvidenceFiles");
const { requirePreparationEvidence } = require("./pipelinePreparationEvidence");
const { bindPreparationMap, sourceClockTickForFile } = require("./pipelinePreparationMap");
const { planPreparation } = require("./pipelinePreparation");
const { inspectStreams } = require("./mediaSourceProbe");
const { approveAudioSelectionIntent, audioSelectionInputs, planAudioValueSelection } = require("./audioValueSelection");
const { validateReceipt } = require("./mediaClockProtocol");
const { validateValueReceipt, CPU_PLUGIN_SHA256, normalizesAudio } = require("./mediaAudioValueProtocol");
const { validateVideoRequest, validateVideoReceipt } = require("./pipelineVideoProtocol");
const { selectedVideoSidecars } = require("./pipelineVideo");
const { bindSubtitleExtractions } = require("./pipelineSubtitleEvidence");
const { requireStageProducer } = require("./mediaStageProducer");
const { requireAudioTransport } = require("./mediaAudioTransportAdmission");
const { requireAudioValueBasis } = require("./mediaAudioValueBasis");
const { validateNormalizedEofContext } = require("./mediaAudioEofContext");
require("./mediaAudioValueWorker");
require("./pipelineVideoWorker");

function unchanged(input, digestCache) {
  let actual = digestCache?.get(input.file);
  if (!actual) {
    actual = fileDigest(input.file);
    digestCache?.set(input.file, actual);
  }
  if (!sameFileGeneration(input.identity, actual)) throw Error("Finish input changed after its stage proof");
}

function stageTools(receipt, tools) {
  assert.deepEqual(receipt.decoder, tools.decoder, "Finish decoder generation differs from stage proof");
  assert.deepEqual(receipt.prober, tools.prober, "Finish prober generation differs from stage proof");
}

function preparationChain(request, tools, digestCache) {
  const intent = readRetainedReceipt(request.preparation);
  if (intent.schema !== "media-preparation-intent.v1" || intent.scope !== "admitted-policy-and-preparation" || intent.status !== "pass"
      || intent.originalId !== request.originalFile || intent.preparedId !== request.preparedFile
      || intent.actual?.sourceId !== intent.mapping?.sourceId || intent.sourceInput?.file !== intent.mapping?.sourceId
      || typeof intent.actual.extractionFailed !== "boolean") {
    throw Error("Finish lacks admitted preparation policy");
  }
  assert.deepEqual(intent.settings, request.settings, "Finish changed admitted helper policy");
  stageTools(intent, tools);
  const clock = readRetainedReceipt(intent.evidence);
  requireStageProducer(clock, "./mediaClockWorker");
  stageTools(clock, tools);
  const args = { variables: { mediaPipelinePreparation: intent.mapping, mediaPipelinePreparationEvidence: clock } };
  requirePreparationEvidence(args, { originalId: request.originalFile, preparedId: request.preparedFile });
  assert.deepEqual(intent.inputs, clock.inputs, "Preparation intent and proof bind different bytes");
  intent.inputs.forEach(item => unchanged(item, digestCache));
  unchanged(intent.sourceInput, digestCache);
  const source = { _id: intent.sourceInput.file, container: path.extname(request.originalFile).slice(1),
    ffProbeData: { streams: inspectStreams(request.originalFile, tools.ffprobe) } };
  const candidate = { _id: request.preparedFile, ffProbeData: { streams: inspectStreams(request.preparedFile, tools.ffprobe) } };
  const plan = planPreparation(source, request.originalFile, request.settings);
  assert.deepEqual(intent.actual.subtitles, bindSubtitleExtractions(plan.subtitleTargets, intent.actual.extractionFailed),
    "Subtitle extraction inventory changed after preparation");
  assert.deepEqual(bindPreparationMap(source, candidate, plan.retainedStreamIndices, request.originalFile), intent.mapping,
    "Finish preparation inventory differs from admitted cleanup");
  return { intent, clock, source, candidate };
}

function audioChain(request, tools, preparation, digestCache) {
  const intent = readRetainedReceipt(request.audioIntent);
  if (intent.schema !== "media-audio-intent.v1" || intent.scope !== "executed-audio-policy-and-handoff" || intent.status !== "pass"
      || intent.source?.file !== request.preparedFile || intent.candidate?.file !== request.audioFile) throw Error("Finish lacks executed audio policy");
  assert.deepEqual(intent.preparation, request.preparation, "Audio outcome belongs to another preparation");
  [intent.source, intent.candidate].forEach(item => unchanged(item, digestCache));
  const args = { inputs: intent.inputs, inputFileObj: { _id: request.preparedFile } };
  assert.deepEqual(audioSelectionInputs(args), intent.inputs, "Noncanonical audio policy");
  const streams = inspectStreams(request.preparedFile, tools.ffprobe);
  if (request.audioFile === request.preparedFile) {
    if (intent.handoff !== null || planAudioValueSelection(args, streams).planned.audioPlanSet.status.kind !== "passThrough") {
      throw Error("Unchanged audio does not satisfy its requested policy");
    }
    return { intent, clock: null, values: null, handoff: null };
  }
  const handoff = readRetainedReceipt(intent.handoff);
  if (handoff.schema !== "media-audio-handoff.v2" || handoff.scope !== "configured-selection-and-verified-audio-rename" || handoff.status !== "pass"
      || !Array.isArray(handoff.evidence) || ![1, 2].includes(handoff.evidence.length)) throw Error("Incomplete audio rename proof");
  assert.deepEqual(handoff.source, intent.source);
  assert.deepEqual(handoff.candidate, intent.candidate);
  const [clock, values = null] = handoff.evidence.map(readRetainedReceipt);
  requireStageProducer(clock, "./mediaClockWorker");
  if (values) requireStageProducer(values, "./mediaAudioValueWorker");
  const expectedTick = request.originalFile !== request.preparedFile
    ? sourceClockTickForFile(request.originalFile, tools.ffprobe) : null;
  validateReceipt(clock, { sourceFile: request.preparedFile, candidateFile: handoff.temporary,
    audioMap: clock.audioMap, videoMap: clock.videoMap,
    ...(clock.eofContext ? { eofContext: clock.eofContext } : {}),
    ...(expectedTick ? { sourceClockTick: expectedTick } : {}) });
  if (clock.status !== "pass") throw Error("Incomplete audio clock acceptance");
  if (values) {
    validateValueReceipt(values, values.request);
    if (values.status !== "pass" || values.request.sourceFile !== request.preparedFile
        || values.request.candidateFile !== handoff.temporary
        || (values.request.maps.some(normalizesAudio) && values.request.plugin.sha256 !== CPU_PLUGIN_SHA256)) {
      throw Error("Incomplete independent normalized audio acceptance");
    }
  }
  for (const proof of values ? [clock, values] : [clock]) {
    stageTools(proof, tools);
    if (proof.inputs.length !== 2 || !sameFileGeneration(proof.inputs.find(input => input.file === request.preparedFile)?.identity, intent.source.identity)
        || !sameFileGeneration(proof.inputs.find(input => input.file === handoff.temporary)?.identity, intent.candidate.identity, true)) {
      throw Error("Audio proof changed its handoff generation");
    }
  }
  const expectedMaps = values ? values.request.maps : handoff.selection?.maps;
  if (!Array.isArray(expectedMaps) || clock.audioMap.length !== expectedMaps.length || expectedMaps.some((map, index) => {
    const timed = clock.audioMap[index];
    return timed.sourceIndex !== map.sourceIndex || timed.candidateIndex !== map.candidateIndex || timed.channels !== map.channels;
  })) throw Error("Audio values and clocks cover different original tracks");
  assert.deepEqual(approveAudioSelectionIntent(args, handoff.selection, streams), expectedMaps,
    "Audio proof differs from executed selection");
  const transport = requireAudioTransport(handoff, clock, tools);
  const valueBasis = values ? requireAudioValueBasis(values,
    transport.inputs.find(input => input.file === transport.request.candidateFile),
    { from: handoff.temporary, to: handoff.candidate.file }) : null;
  let eofContext = null;
  if (clock.eofContext || handoff.eofContext || transport.request.eofContext) {
    assert.ok(clock.eofContext && handoff.eofContext && transport.request.eofContext,
      "Normalized EOF context must bind clock, transport and handoff");
    assert.deepEqual(handoff.eofContext, clock.eofContext, "Handoff and clock bind different EOF contexts");
    assert.deepEqual(transport.request.eofContext, clock.eofContext, "Transport and clock bind different EOF contexts");
    if (values) assert.ok(valueBasis, "Normalized EOF finish requires the retained first-candidate value basis");
    const eofArgs = {
      inputs: intent.inputs,
      inputFileObj: { _id: request.preparedFile },
      originalLibraryFile: { _id: request.originalFile },
      ffmpegPath: tools.decoder.executable,
      ffprobePath: tools.prober.executable,
      variables: {
        mediaPipeline: true,
        mediaPipelinePreparation: preparation.intent.mapping,
        mediaPipelinePreparationEvidence: preparation.clock,
      },
    };
    eofContext = validateNormalizedEofContext(readRetainedReceipt(handoff.eofContext), {
      args: eofArgs, candidateFile: transport.request.candidateFile,
      expectedPluginSha256: values ? CPU_PLUGIN_SHA256 : null,
      renamed: { from: handoff.temporary, to: handoff.candidate.file },
    });
    if (values) assert.deepEqual(eofContext.valueBasis, values.request.basis, "Finish EOF basis differs from final values");
    assert.deepEqual(eofContext.preparation?.evidence, preparation.intent.evidence, "Finish EOF preparation differs");
  }
  return { intent, clock, values, handoff, transport, valueBasis, eofContext };
}

function videoChain(request, tools, preparation, digestCache) {
  if (!Array.isArray(request.videos) || request.videos.length < 1 || request.videos.length > 2) throw Error("Missing final video stage coverage");
  const receipts = request.videos.map(readRetainedReceipt);
  let source = request.audioFile;
  receipts.forEach((receipt, index) => {
    validateVideoRequest(receipt.request);
    validateVideoReceipt(receipt, receipt.request);
    requireStageProducer(receipt, "./pipelineVideoWorker");
    if (receipt.status !== "pass" || receipt.request.sourceFile !== source
        || (index === 0 && receipt.request.sidecars.length) || (index === 1 && !receipt.request.sidecars.length)) {
      throw Error("Video stage chain is incomplete or reordered");
    }
    assert.deepEqual(receipt.request.settings, { videoPreset: request.settings.videoPreset, videoQuality: request.settings.videoQuality });
    stageTools(receipt, tools);
    receipt.inputs.forEach(item => unchanged(item, digestCache));
    if (receipt.reference) unchanged({ file: receipt.reference.file, identity: receipt.reference.identity }, digestCache);
    if (index === 1) assert.deepEqual(receipt.request.sidecars,
      selectedVideoSidecars(request.originalFile, request.settings.sidecars, preparation.intent.actual), "Companion selection changed");
    unchanged(receipt.output, digestCache);
    if (receipt.transport) {
      const { requireCarrierEvidence } = require("./mediaCarrierEvidence");
      const { encodeClockPlan } = require("./audioClockPlan");
      requireCarrierEvidence(receipt.transport.carrier, receipt.transport.plan, receipt.producer, encodeClockPlan(receipt.transport.plans));
    }
    source = receipt.output.file;
  });
  if (source !== request.candidateFile) throw Error("Final candidate bypasses its verified video chain");
  return receipts;
}

function verifyFinishChain(request, tools, digestCache = new Map()) {
  const preparation = preparationChain(request, tools, digestCache);
  const audio = audioChain(request, tools, preparation, digestCache);
  const videos = videoChain(request, tools, preparation, digestCache);
  return { preparation, audio, videos };
}

module.exports = { verifyFinishChain };
