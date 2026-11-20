"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateNativePcmPair } = require("./mediaPcmEvidence");

const SCHEMA = "media-audio-values.v2";
const SCOPE = "complete-native-audio-values-only";
const CPU_PLUGIN_SHA256 = "7e1f92d9aa6ab0ee5b97894119ff29418a9e4bb47679c5e120a0fb5aa0064d01";
const digest = value => /^[a-f0-9]{64}$/.test(value || "");
const normalizesAudio = map => ["normalize", "normalizeAac"].includes(map.kind);

function canonical(file) {
  return typeof file === "string" && !file.includes("\0") && path.isAbsolute(file)
    && path.resolve(file) === file && fs.realpathSync(file) === file;
}

function validateValueRequest(request) {
  const basis = request && Object.hasOwn(request, "basis");
  const keys = `${basis ? "basis," : ""}candidateFile,directory,ffmpegPath,ffprobePath,maps,plugin,sourceFile`;
  if (!request || Object.keys(request).sort().join() !== keys
      || ![request.sourceFile, request.candidateFile, request.directory].every(canonical)
      || ![request.ffmpegPath, request.ffprobePath].every(value => typeof value === "string" && value.trim() && !value.includes("\0"))) throw Error("Invalid audio value request");
  validateValueMaps(request.maps);
  if (request.maps.some(normalizesAudio)) {
    if (!request.plugin || Object.keys(request.plugin).sort().join() !== "file,sha256"
        || !canonical(request.plugin.file) || !digest(request.plugin.sha256)) throw Error("Invalid independent CPU plugin identity");
  } else if (request.plugin !== null) throw Error("Unexpected CPU plugin for copied/compatibility audio");
  if (basis) validateBasisBinding(request);
}

function validateBasisBinding(request) {
  const basis = request.basis;
  if (!basis || Object.keys(basis).sort().join() !== "file,identity" || !canonical(basis.file)
      || Object.keys(basis.identity || {}).sort().join() !== "bytes,sha256,stamp"
      || !digest(basis.identity.sha256) || !Number.isSafeInteger(basis.identity.bytes) || basis.identity.bytes < 1
      || typeof basis.identity.stamp !== "string" || path.basename(basis.file) !== "receipt.json"
      || path.dirname(path.dirname(basis.file)) !== request.directory
      || !/^\.media-values-[A-Za-z0-9]+$/.test(path.basename(path.dirname(basis.file)))) {
    throw Error("Invalid same-execution audio comparison basis");
  }
}

function validateValueMaps(maps) {
  if (!Array.isArray(maps) || !maps.length || maps.length > 128) throw Error("Invalid audio value coverage");
  maps.forEach((map, index) => {
    if (!map || Object.keys(map).sort().join() !== "candidateIndex,channels,id,inputs,kind,sourceIndex,stereo"
        || map.id !== `a${index}` || map.candidateIndex !== index
        || !Number.isSafeInteger(map.sourceIndex) || map.sourceIndex < 0 || map.sourceIndex > 255
        || !Number.isSafeInteger(map.channels) || map.channels < 1 || map.channels > 64
        || !["copy", "normalize", "normalizeAac", "encode"].includes(map.kind) || typeof map.stereo !== "boolean") throw Error("Invalid audio value mapping");
    if (!normalizesAudio(map)) {
      if (map.inputs !== null || map.stereo) throw Error("Unexpected non-normalized transform settings");
    } else {
      const inputs = map.inputs;
      if (!inputs || Object.keys(inputs).sort().join() !== "i,lra,maxGain,tp"
          || Object.values(inputs).some(value => typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value))
          || Number(inputs.i) < -70 || Number(inputs.i) > -5 || Number(inputs.lra) < 1 || Number(inputs.lra) > 50
          || Number(inputs.tp) < -9 || Number(inputs.tp) > 0 || Number(inputs.maxGain) < 0
          || (map.stereo && map.channels !== 2)) throw Error("Invalid independent normalization settings");
    }
  });
}

function validatePcmPair(item) {
  if (!Array.isArray(item.values) || item.values.length !== 1) throw Error("Incomplete native audio proof");
  const value = item.values[0];
  if (value.map_id !== item.id || !["pass", "held"].includes(value.status) || !Array.isArray(value.errors)
      || (value.status === "pass") !== (value.errors.length === 0)) throw Error("Invalid native audio verdict");
  if (value.status !== "pass") return;
  validateNativePcmPair(value);
}

function validateComparisonReference(value, item, map) {
  const comparison = item.comparisonReference;
  if (!comparison || Object.keys(comparison).sort().join() !== "audioIndex,file,identity"
      || !canonical(comparison.file) || !Number.isSafeInteger(comparison.audioIndex)
      || comparison.audioIndex !== (map.kind === "copy" ? map.sourceIndex : 0)
      || Object.keys(comparison.identity || {}).sort().join() !== "bytes,sha256,stamp"
      || !digest(comparison.identity.sha256) || !Number.isSafeInteger(comparison.identity.bytes)
      || comparison.identity.bytes < 1 || typeof comparison.identity.stamp !== "string") {
    throw Error("Missing actual audio comparison reference");
  }
  const source = value.inputs.find(input => input.file === value.request.sourceFile);
  let expected = source;
  if (normalizesAudio(map)) expected = item.composition?.output || item.reference.output;
  if (map.kind === "encode") {
    const proof = item.reference;
    if (!proof || proof.codec !== "aac" || proof.bitrate !== "192k"
        || ["sha256", "bytes", "stamp"].some(key => proof.source?.[key] !== source.identity[key])) {
      throw Error("Missing independent encoding reference");
    }
    expected = { file: comparison.file, identity: proof.output };
  }
  const directory = path.dirname(value.receiptPath || "");
  const referenceDirectory = value.request.basis ? path.dirname(value.request.basis.file) : directory;
  if (!canonical(directory) || path.dirname(directory) !== value.request.directory
      || !/^\.media-values-[A-Za-z0-9]+$/.test(path.basename(directory))
      || value.receiptPath !== path.join(directory, "receipt.json")
      || ((map.kind === "encode" || comparison.file !== source.file)
        && !comparison.file.startsWith(path.join(referenceDirectory, map.id) + path.sep))
      || comparison.file !== expected?.file
      || ["sha256", "bytes", "stamp"].some(key => comparison.identity[key] !== expected?.identity?.[key])) {
    throw Error("Audio comparison reference differs from its proof");
  }
}

function validateValueReceipt(value, request) {
  if (request && Object.hasOwn(request, "basis")) validateBasisBinding(request);
  if (!value || value.schema !== SCHEMA || value.scope !== SCOPE || !["pass", "held"].includes(value.status)
      || !Array.isArray(value.errors) || (value.status === "pass") !== (value.errors.length === 0)
      || JSON.stringify(value.request) !== JSON.stringify(request)
      || !Array.isArray(value.results) || value.results.length !== request.maps.length
      || !Array.isArray(value.inputs) || value.inputs.length !== new Set([request.sourceFile, request.candidateFile]).size) throw Error("Invalid audio value receipt");
  for (const file of new Set([request.sourceFile, request.candidateFile])) {
    const identity = value.inputs.find(input => input.file === file)?.identity;
    if (!identity || !digest(identity.sha256) || !Number.isSafeInteger(identity.bytes) || identity.bytes < 1
        || typeof identity.stamp !== "string") throw Error("Missing audio input identity");
  }
  value.results.forEach((item, index) => {
    const map = request.maps[index];
    if (item.id !== map.id || item.kind !== map.kind || !["pass", "held"].includes(item.status)
        || (item.status !== "pass" && value.status === "pass")) throw Error("Incomplete audio transform coverage");
    if (item.status !== "pass") return;
    validatePcmPair(item);
    if (item.values[0].status !== "pass") throw Error("Contradictory audio value proof");
    if (normalizesAudio(map)) {
      const proof = item.reference;
      if (proof?.version !== "normalization-reference-proof-v1"
          || proof.inputs.source_audio_index !== map.sourceIndex || JSON.stringify(proof.inputs.settings) !== JSON.stringify(map.inputs)
          || proof.inputs.stereo !== map.stereo || proof.inputs.reference_inputs.plugin_file !== request.plugin.file
          || !proof.inputs.reference_inputs.modules.some(([file, identity]) => file === request.plugin.file && identity.sha256 === request.plugin.sha256)
           || !digest(proof.output?.identity?.sha256) || !digest(proof.prepared_input?.identity?.sha256)) throw Error("Missing independent CPU normalization proof");
      if (map.kind === "normalizeAac") {
        const skipped = proof.output.file === proof.prepared_input.file;
        const composition = item.composition;
        if (!skipped && composition !== null) throw Error("Unexpected normalization composition");
        if (skipped && (!composition || JSON.stringify(composition.source) !== JSON.stringify(proof.output)
            || composition.codec !== "aac" || composition.bitrate !== "192k" || composition.stereo !== map.stereo
            || ![".mkv", ".mp4", ".mov", ".m4a"].includes(composition.container)
             // Re-comparison keeps the original encoding recipe; its successful
             // fresh basis independently binds the pre-transport container.
             || (!Object.hasOwn(request, "basis") && composition.container !== path.extname(request.candidateFile).toLowerCase())
            || !Array.isArray(composition.inputs) || composition.inputs.length !== (map.stereo ? 2 : 1)
            || JSON.stringify(composition.inputs[0]) !== JSON.stringify(proof.output)
            || ![...composition.inputs, composition.output].every(input => typeof input?.file === "string"
              && digest(input.identity?.sha256) && Number.isSafeInteger(input.identity?.bytes) && input.identity.bytes > 0
              && typeof input.identity.stamp === "string"))) throw Error("Missing independent skipped-normalization encoding proof");
      }
    }
    validateComparisonReference(value, item, map);
  });
}

module.exports = { SCHEMA, SCOPE, CPU_PLUGIN_SHA256, normalizesAudio, validateValueMaps, validateValueRequest, validateValueReceipt };
