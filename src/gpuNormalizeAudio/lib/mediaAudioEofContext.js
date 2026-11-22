"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { mediaTools } = require("./mediaTools");
const { inspectMedia, inspectStreams } = require("./mediaSourceProbe");
const { decoderIdentity } = require("./mediaEvidenceTools");
const { fileDigest, sameFileGeneration, readRetainedReceipt, retainedReceipt, writePrivateReceipt } = require("./mediaEvidenceFiles");
const { createAudioSelectionIntent, approveAudioValueMaps, audioValueMaps } = require("./audioValueSelection");
const { CPU_PLUGIN_SHA256, normalizesAudio, validateValueReceipt } = require("./mediaAudioValueProtocol");
const { audioReferenceInputs } = require("./mediaAudioReference");
const { requireStageProducer } = require("./mediaStageProducer");
const { requirePreparationEvidence } = require("./pipelinePreparationMap");
const { observeNativeAudioWindow } = require("./mediaOriginalAudioWindow");
const { normalizedAacCountDomain } = require("./audioSampleCounts");
const { storedAudioPresentation, validateDeclaredWindow } = require("./mediaAudioWindow");
const { validateEofBinding } = require("./mediaClockProtocol");
const { assertNormalizedAacWindowCounts } = require("./audioClockPlan");
require("./mediaAudioValueWorker");

const SCHEMA = "media-audio-eof-context.v1";
const SCOPE = "generation-bound-normalized-eof-context";
const CONTEXT_KEYS = "candidate,decoder,preparation,prober,schema,scope,selection,source,streams,valueBasis";

function canonicalPath(file) {
  return typeof file === "string" && !file.includes("\0") && path.isAbsolute(file)
    && path.resolve(file) === file && fs.realpathSync(file) === file;
}

function resolveCandidateFile(candidateFile, renamed) {
  if (!renamed || candidateFile !== renamed.from) return candidateFile;
  assert.equal(path.dirname(renamed.from), path.dirname(renamed.to), "Normalized EOF rename changed directory");
  assert.ok(!fs.existsSync(renamed.from) && fs.realpathSync(renamed.to) === renamed.to,
    "Normalized EOF candidate rename is not complete");
  return renamed.to;
}

function assertFileUnchanged(input, label, renamed = null) {
  if (renamed && input.file === renamed.from) {
    const target = resolveCandidateFile(input.file, renamed);
    assert.ok(sameFileGeneration(input.identity, fileDigest(target), true), `${label} changed across rename`);
    return;
  }
  assert.ok(sameFileGeneration(input.identity, fileDigest(input.file)), `${label} changed`);
}

function readFreshValueBasis(valueBasis, sourceFile, candidateFile, tools, renamed = null) {
  const basis = readRetainedReceipt(valueBasis);
  assert.ok(!Object.hasOwn(basis.request, "basis"), "Normalized EOF requires the fresh first-candidate value basis");
  validateValueReceipt(basis, basis.request);
  assert.equal(basis.status, "pass", "Normalized EOF requires passing first-candidate CPU values");
  requireStageProducer(basis, "./mediaAudioValueWorker");
  assert.equal(basis.request.sourceFile, sourceFile, "Value basis source differs from execution");
  assert.equal(basis.request.candidateFile, candidateFile, "Value basis candidate differs from execution");
  assert.deepEqual(basis.decoder, tools.decoder, "Value basis decoder generation differs");
  assert.deepEqual(basis.prober, tools.prober, "Value basis prober generation differs");
  for (const input of [...basis.inputs, ...basis.results.flatMap(audioReferenceInputs)]) {
    assertFileUnchanged(input, "Normalized EOF value-basis generation", renamed);
  }
  return basis;
}

function resolvePreparationAuthority(args, source, tools) {
  if (!args.variables?.mediaPipeline) {
    assert.ok(!args.variables?.mediaPipelinePreparation && !args.variables?.mediaPipelinePreparationEvidence,
      "Unexpected preparation state outside media pipeline");
    return null;
  }
  const originalId = args.originalLibraryFile?._id;
  assert.ok(typeof originalId === "string" && originalId.length > 0, "Missing admitted original for preparation");
  const receipt = requirePreparationEvidence(args, { originalId, preparedId: source.file });
  requireStageProducer(receipt, "./mediaClockWorker");
  assert.deepEqual(receipt.decoder, tools.decoder, "Preparation decoder generation differs");
  assert.deepEqual(receipt.prober, tools.prober, "Preparation prober generation differs");
  receipt.inputs.forEach(input => assertFileUnchanged(input, "Preparation input generation"));
  const preparedInput = receipt.inputs.find(input => input.file === source.file);
  assert.ok(sameFileGeneration(preparedInput?.identity, source.identity), "Prepared source generation differs");
  return {
    original: { file: originalId, identity: fileDigest(originalId) },
    mapping: args.variables.mediaPipelinePreparation,
    evidence: retainedReceipt(receipt),
  };
}

function resolveOriginalOrdinal(preparation, source, sourceIndex) {
  if (!preparation) return { file: source.file, identity: source.identity, audioIndex: sourceIndex };
  const entry = preparation.mapping.streams.find(stream => stream.type === "audio" && stream.preparedOrdinal === sourceIndex);
  assert.ok(entry, "Prepared audio ordinal has no admitted original mapping");
  return { file: preparation.original.file, identity: preparation.original.identity, audioIndex: entry.sourceOrdinal };
}

function isGenuinelyNormalized(map, result) {
  return normalizesAudio(map) && result.reference.output.file !== result.reference.prepared_input.file;
}

function originalDecodedSamples(originalWindow) {
  const win = originalWindow.window;
  if (originalWindow.scope === "observed-iso-aac-window-only") {
    const packets = BigInt(win.samples);
    const priming = BigInt(win.mediaTime || 0);
    return packets * 1024n - priming;
  }
  return BigInt(win.samples);
}

// Explicit generation-bound EOF context joining configured selection, fresh
// first-candidate CPU values and admitted-original presentation windows.
function buildNormalizedEofContext(args, { valueBasis = null, selectionMaps = null, candidateFile, expectedPluginSha256 = CPU_PLUGIN_SHA256, renamed = null }) {
  const sourceFile = args.inputFileObj._id;
  const rawTools = mediaTools(args);
  const decoder = decoderIdentity(rawTools.ffmpeg), prober = decoderIdentity(rawTools.ffprobe);
  const ffprobeExec = (prober.native || prober).executable;
  const tools = { decoder, prober };
  const source = { file: sourceFile, identity: fileDigest(sourceFile) };
  const actualCandidate = resolveCandidateFile(candidateFile, renamed);
  const basis = valueBasis ? readFreshValueBasis(valueBasis, sourceFile, candidateFile, tools, renamed) : null;
  const maps = basis ? basis.request.maps : selectionMaps;
  assert.ok(Array.isArray(maps) && maps.length > 0, "Normalized EOF requires approved audio maps");
  const candidate = { file: candidateFile,
    identity: basis && renamed && candidateFile === renamed.from
      ? basis.inputs.find(input => input.file === candidateFile).identity : fileDigest(actualCandidate) };
  const sourceStreams = inspectStreams(sourceFile, ffprobeExec);
  const selection = createAudioSelectionIntent(args, maps, sourceStreams);
  assert.deepEqual(selection.maps, maps, "Value basis maps differ from approved selection");
  const preparation = resolvePreparationAuthority(args, source, tools);
  const sourceAudio = sourceStreams.filter(stream => stream.type === "audio");
  const candidateAudio = inspectStreams(actualCandidate, ffprobeExec).filter(stream => stream.type === "audio");
  assert.equal(candidateAudio.length, selection.maps.length, "Candidate audio coverage differs from selection");

  const streams = selection.maps.map((map, index) => {
    const result = basis ? basis.results[index] : null;
    if (basis ? !isGenuinelyNormalized(map, result) : !normalizesAudio(map)) {
      return { id: map.id, mode: "strict", sourceIndex: map.sourceIndex,
        candidateIndex: map.candidateIndex, channels: map.channels };
    }
    if (basis) assert.equal(basis.request.plugin?.sha256, expectedPluginSha256, "Normalized EOF requires pinned CPU plugin");
    const srcStream = sourceAudio[map.sourceIndex], candStream = candidateAudio[map.candidateIndex];
    assert.ok(srcStream && candStream?.codec_name === "aac" && Number(candStream.channels) === map.channels,
      "Normalized EOF requires mapped AAC candidate output");
    const sourceRate = Number(srcStream.sample_rate), encodedRate = Number(candStream.sample_rate);
    const origin = resolveOriginalOrdinal(preparation, source, map.sourceIndex);
    const originalWindow = observeNativeAudioWindow(origin.file, origin.audioIndex, rawTools.ffprobe, path.dirname(actualCandidate));
    assert.equal(originalWindow.sampleRate, sourceRate, "Prepared audio rate differs from admitted original");
    assert.ok(sameFileGeneration(originalWindow.identity, origin.identity), "Admitted original generation changed");
    let cpuDecodedSamples;
    if (basis) {
      const pair = result.values[0];
      assert.equal(pair.candidate.samples, pair.source.samples, "First-candidate CPU decoded samples disagree");
      assert.ok(Number.isSafeInteger(pair.source.samples) && pair.source.samples > 0, "Invalid CPU decoded sample count");
      const rawSamples = BigInt(pair.source.samples), channels = BigInt(map.channels);
      assert.equal(rawSamples % channels, 0n, "CPU decoded sample count is not aligned to channel count");
      cpuDecodedSamples = rawSamples / channels;
    } else {
      cpuDecodedSamples = normalizedAacCountDomain({
        sourceSamples: originalDecodedSamples(originalWindow), sourceRate, encodedRate, stereo: map.stereo,
      }).decodedSamples;
    }
    assert.ok(cpuDecodedSamples > 0n, "Invalid CPU decoded frame count");
    return {
      id: map.id, mode: "normalized-aac", sourceIndex: map.sourceIndex, candidateIndex: map.candidateIndex,
      channels: map.channels, stereo: map.stereo, sourceRate, encodedRate,
      cpuDecodedSamples: String(cpuDecodedSamples),
      original: { file: origin.file, identity: originalWindow.identity,
        audioIndex: origin.audioIndex, streamIndex: originalWindow.streamIndex },
      originalWindow,
    };
  });

  assertFileUnchanged(source, "Normalized EOF source generation");
  assertFileUnchanged(candidate, "Normalized EOF candidate generation", renamed);
  if (preparation) assertFileUnchanged(preparation.original, "Normalized EOF original generation");
  assert.deepEqual(decoderIdentity(rawTools.ffmpeg), decoder, "Normalized EOF decoder changed");
  assert.deepEqual(decoderIdentity(rawTools.ffprobe), prober, "Normalized EOF prober changed");
  return {
    schema: SCHEMA, scope: SCOPE, source, candidate, selection, valueBasis: valueBasis || null,
    preparation, decoder, prober, streams,
  };
}

function validateNormalizedEofContext(context, { args, candidateFile, expectedPluginSha256 = CPU_PLUGIN_SHA256, renamed = null }) {
  const clean = context && Object.fromEntries(Object.entries(context).filter(([key]) => key !== "receiptPath"));
  assert.ok(clean && Object.keys(clean).sort().join() === CONTEXT_KEYS
    && clean.schema === SCHEMA && clean.scope === SCOPE, "Invalid normalized EOF context");
  const expected = buildNormalizedEofContext(args, {
    valueBasis: clean.valueBasis, selectionMaps: clean.valueBasis ? null : clean.selection?.maps,
    candidateFile, expectedPluginSha256, renamed,
  });
  if (!clean.valueBasis && renamed && candidateFile === renamed.from
      && sameFileGeneration(clean.candidate?.identity, expected.candidate?.identity, true)) {
    expected.candidate = { ...expected.candidate, identity: clean.candidate.identity };
  }
  assert.deepEqual(clean, expected, "Normalized EOF context differs from verified execution state");
  return clean;
}

function retainNormalizedEofContext(args, options) {
  const context = buildNormalizedEofContext(args, options);
  const receipt = writePrivateReceipt(path.dirname(options.candidateFile), "media-eof-context", context);
  args.variables = { ...args.variables, gpuNormalizeAudioEofContext: receipt };
  return retainedReceipt(receipt);
}

function streamMayNeedNormalizedEof(map, result, srcStream, candStream, track) {
  if (!srcStream || candStream?.codec_name !== "aac" || !track) return false;
  const sourceRate = Number(srcStream.sample_rate), encodedRate = Number(candStream.sample_rate);
  if (sourceRate === encodedRate) return false;
  const rawSamples = BigInt(result?.values?.[0]?.source?.samples || 0), channels = BigInt(map.channels);
  if (rawSamples <= 0n || channels <= 0n || rawSamples % channels !== 0n) return true;
  const cpuDecodedSamples = rawSamples / channels;
  const codedSamples = track.durationRuns.reduce((sum, run) => sum + BigInt(run.count) * BigInt(run.duration), 0n)
    - BigInt(track.mediaTime);
  const noEofTrim = BigInt(track.declaredEnd.numerator) * BigInt(track.rate)
    >= BigInt(track.presentationEnd) * BigInt(track.declaredEnd.denominator);
  return !(noEofTrim && codedSamples > 0n && codedSamples * BigInt(encodedRate) === cpuDecodedSamples * BigInt(sourceRate));
}

// Build and retain a normalized EOF context only when normalized AAC targets
// an ISO MOV/MP4 candidate from an admitted ISO MOV/MP4 or Matroska original
// and decoded duration may genuinely differ from the source (e.g. non-integral
// rate conversion or non-AAC frame padding into 1024-sample AAC). Unsupported
// containers and exact-duration streams return null so strict clocks stay active.
function maybeRetainNormalizedEofContext(args, { valueBasis = null, audioSpecs = null, outputContract = null, candidateFile, expectedPluginSha256 = CPU_PLUGIN_SHA256 }) {
  const basis = valueBasis ? readRetainedReceipt(valueBasis) : null;
  const rawTools = mediaTools(args), prober = decoderIdentity(rawTools.ffprobe);
  const ffprobeExec = (prober.native || prober).executable;
  const candidateMedia = inspectMedia(candidateFile, ffprobeExec);
  if (!String(candidateMedia.format?.format_name || "").split(",").includes("mov")) return null;
  const sourceFile = args.inputFileObj._id;
  const sourceStreams = inspectStreams(sourceFile, ffprobeExec);
  const sourceAudio = sourceStreams.filter(stream => stream.type === "audio");
  const candidateAudio = candidateMedia.streams.filter(stream => stream.codec_type === "audio");
  const maps = basis ? basis.request.maps : approveAudioValueMaps(args, audioValueMaps(args, audioSpecs, outputContract), sourceStreams);
  const normalizedEntries = maps
    .map((map, index) => ({ map, result: basis ? basis.results[index] : null }))
    .filter(({ map, result }) => (basis ? isGenuinelyNormalized(map, result) : normalizesAudio(map)));
  if (!normalizedEntries.length) return null;
  const originalFile = args.variables?.mediaPipeline ? args.originalLibraryFile?._id : sourceFile;
  if (!originalFile || !canonicalPath(originalFile)) return null;
  const originalMedia = inspectMedia(originalFile, ffprobeExec);
  const origFormats = String(originalMedia.format?.format_name || "").split(",");
  const isOrigMov = origFormats.includes("mov"), isOrigMkv = origFormats.includes("matroska");
  if (!isOrigMov && !isOrigMkv) return null;
  const originalAudio = originalMedia.streams.filter(stream => stream.codec_type === "audio");
  const mapping = args.variables?.mediaPipeline ? args.variables?.mediaPipelinePreparation : null;
  const ordinals = normalizedEntries.map(({ map }) => (mapping
    ? mapping.streams?.find(stream => stream.type === "audio" && stream.preparedOrdinal === map.sourceIndex)?.sourceOrdinal
    : map.sourceIndex));
  if (ordinals.some(ordinal => !Number.isSafeInteger(ordinal) || !originalAudio[ordinal])) return null;
  let movTracks = null;
  const needsEof = normalizedEntries.some(({ map, result }, index) => {
    const srcStream = sourceAudio[map.sourceIndex], candStream = candidateAudio[map.candidateIndex];
    const origStream = originalAudio[ordinals[index]];
    if (!srcStream || candStream?.codec_name !== "aac") return false;
    const sourceRate = Number(srcStream.sample_rate), encodedRate = Number(candStream.sample_rate);
    const observed = observeNativeAudioWindow(originalFile, ordinals[index], rawTools.ffprobe, path.dirname(candidateFile));
    let cpuDecodedSamples;
    if (basis) {
      if (isOrigMov && origStream.codec_name === "aac") {
        if (sourceRate === encodedRate) return false;
        movTracks ??= storedAudioPresentation(originalFile).tracks;
        return streamMayNeedNormalizedEof(map, result, srcStream, candStream, movTracks[ordinals[index]]);
      }
      const rawSamples = BigInt(result?.values?.[0]?.source?.samples || 0), channels = BigInt(map.channels);
      if (rawSamples <= 0n || channels <= 0n || rawSamples % channels !== 0n) return true;
      cpuDecodedSamples = rawSamples / channels;
    } else {
      cpuDecodedSamples = normalizedAacCountDomain({
        sourceSamples: originalDecodedSamples(observed), sourceRate, encodedRate, stereo: map.stereo,
      }).decodedSamples;
      if (isOrigMov && origStream.codec_name === "aac") {
        if (sourceRate === encodedRate) return false;
        movTracks ??= storedAudioPresentation(originalFile).tracks;
        const track = movTracks[ordinals[index]];
        if (!track) return false;
        const codedSamples = track.durationRuns.reduce((sum, run) => sum + BigInt(run.count) * BigInt(run.duration), 0n)
          - BigInt(track.mediaTime);
        const noEofTrim = BigInt(track.declaredEnd.numerator) * BigInt(track.rate)
          >= BigInt(track.presentationEnd) * BigInt(track.declaredEnd.denominator);
        return !(noEofTrim && codedSamples > 0n && codedSamples * BigInt(encodedRate) === cpuDecodedSamples * BigInt(sourceRate));
      }
    }
    return BigInt(observed.window.samples) * BigInt(encodedRate) !== cpuDecodedSamples * BigInt(sourceRate);
  });
  if (!needsEof) return null;
  return retainNormalizedEofContext(args, {
    valueBasis, selectionMaps: basis ? null : maps, candidateFile, expectedPluginSha256,
  });
}

function readNormalizedEofContextForWorker(eofBinding, { sourceFile, directory, decoder, prober, ffprobePath, expectedPluginSha256 = null }) {
  validateEofBinding(eofBinding, directory);
  const context = readRetainedReceipt(eofBinding);
  assert.equal(context.source?.file, sourceFile, "Normalized EOF context source differs from worker request");
  assert.ok(context.candidate?.file?.startsWith(directory + path.sep), "Normalized EOF candidate is outside this execution");
  assert.deepEqual(context.decoder, decoder, "Normalized EOF decoder differs from worker");
  assert.deepEqual(context.prober, prober, "Normalized EOF prober differs from worker");
  const basis = context.valueBasis ? readRetainedReceipt(context.valueBasis) : null;
  const pluginSha = expectedPluginSha256 ?? basis?.request?.plugin?.sha256 ?? null;
  const workerArgs = {
    inputFileObj: { _id: sourceFile },
    inputs: context.selection?.inputs,
    ffmpegPath: decoder.executable,
    ffprobePath,
    ...(context.preparation ? {
      originalLibraryFile: { _id: context.preparation.original?.file },
      variables: {
        mediaPipeline: true,
        mediaPipelinePreparation: context.preparation.mapping,
        mediaPipelinePreparationEvidence: readRetainedReceipt(context.preparation.evidence),
      },
    } : { variables: {} }),
  };
  return validateNormalizedEofContext(context, {
    args: workerArgs, candidateFile: context.candidate.file, expectedPluginSha256: pluginSha,
  });
}

function usesNormalizedEof(entry, sourceTimeline) {
  return Boolean(entry && entry.mode === "normalized-aac"
    && sourceTimeline.samples * BigInt(entry.encodedRate)
      !== BigInt(entry.cpuDecodedSamples) * BigInt(sourceTimeline.rate));
}

function resolveNormalizedEofCounts(entry, sourceSamples) {
  assert.ok(entry && entry.mode === "normalized-aac", "Count domain requires a verified normalized-aac entry");
  const domain = normalizedAacCountDomain({
    sourceSamples, sourceRate: entry.sourceRate, encodedRate: entry.encodedRate, stereo: entry.stereo,
  });
  assert.equal(domain.decodedSamples, BigInt(entry.cpuDecodedSamples),
    "Normalized count domain differs from proved CPU decoded samples");
  return domain;
}

function assertAudioMapMatchesEofContext(audioMap, eofContext) {
  assert.equal(audioMap.length, eofContext.streams.length, "Audio map coverage differs from normalized EOF context");
  audioMap.forEach((map, index) => {
    const entry = eofContext.streams[index];
    assert.equal(map.id, entry.id, "Audio map ID differs from normalized EOF context");
    assert.equal(map.sourceIndex, entry.sourceIndex, "Audio map source ordinal differs from normalized EOF context");
    assert.equal(map.candidateIndex, entry.candidateIndex, "Audio map candidate ordinal differs from normalized EOF context");
    assert.equal(map.channels, entry.channels, "Audio map channels differ from normalized EOF context");
    if (entry.mode === "normalized-aac") {
      assert.equal(map.compareSamples, false, "Copied audio stream cannot use normalized EOF context");
    }
  });
}

function verifyNormalizedAacWindow(entry, candidateWindow, domain, offset) {
  assertNormalizedAacWindowCounts(candidateWindow, domain, entry.encodedRate);
  validateDeclaredWindow({
    input: entry.originalWindow.window.declaredEnd,
    output: candidateWindow.declaredEnd,
    shift: { numerator: String(offset.numerator), denominator: String(offset.denominator) },
  });
}

module.exports = {
  SCHEMA, SCOPE, validateEofBinding, buildNormalizedEofContext, validateNormalizedEofContext,
  retainNormalizedEofContext, maybeRetainNormalizedEofContext, readNormalizedEofContextForWorker,
  assertAudioMapMatchesEofContext, usesNormalizedEof, resolveNormalizedEofCounts, verifyNormalizedAacWindow,
};
