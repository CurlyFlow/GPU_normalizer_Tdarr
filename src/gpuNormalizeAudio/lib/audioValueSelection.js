"use strict";

const path = require("node:path");
const assert = require("node:assert/strict");
const { createPluginAudioConfig } = require("./pluginConfig");
const { buildAudioPlanContext } = require("./planContext");
const { normalizesAudio, validateValueMaps } = require("./mediaAudioValueProtocol");
const { shouldEncodeCopiedAudioForMp4 } = require("./audioChannelHelpers");
const { boolInput, num } = require("./common");

function audioValueMaps(args, audioSpecs, outputContract) {
  const audio = outputContract.filter(stream => stream.type === "audio");
  if (audio.length !== audioSpecs.length) throw Error("Incomplete audio transform coverage");
  return audioSpecs.map((spec, index) => {
    const map = { id: `a${index}`, sourceIndex: null, candidateIndex: index, channels: Number(audio[index].channels),
      kind: "copy", inputs: null, stereo: false };
    if (spec.kind === "source") {
      const match = /^0:a:(\d+)$/.exec(spec.mapArg);
      if (!match) throw Error("Invalid source transform mapping");
      map.sourceIndex = Number(match[1]);
      const codec = String(spec.stream?.codec_name || spec.stream?.codec || "").toLowerCase();
      if (!codec || !audio[index].codecName) throw Error("Unknown source codec transform");
      if (codec !== audio[index].codecName) map.kind = "encode";
    } else if (["normalizedFile", "directNormalized", "encodedDirectNormalized"].includes(spec.kind)) {
      if (spec.plan?.sourceInput !== args.inputFileObj._id) throw Error("Foreign normalized value source");
      map.sourceIndex = spec.plan.sourceAudioIdx;
      map.kind = "normalize";
      map.stereo = spec.plan.stereoFallback === true;
      map.inputs = { i: String(num(args.inputs?.i, -18)), lra: String(num(args.inputs?.lra, 7)),
        tp: String(num(args.inputs?.tp, -2)), maxGain: String(num(args.inputs?.maxGain, 15)) };
    } else throw Error("Unsupported audio value transformation");
    if (map.kind !== "copy" && (String(args.inputs?.audioBitrate || "192k").toLowerCase() !== "192k"
        || String(args.inputs?.encodeSampleRate || "").trim())) throw Error("Configured encoding lacks the independent CPU parity contract");
    return map;
  });
}

function audioSelectionInputs(args) {
  const config = createPluginAudioConfig({ args: { ...args, inputs: args.inputs || {} }, useGpuSourcePort: true });
  return { i: config.targetI, lra: config.targetLra, tp: config.targetTp, maxGain: config.maxGain,
    ensureStereo: config.ensureStereo, stereoFallbackFirstOnly: config.stereoFallbackFirstOnly,
    stereoFallbackOrder: config.stereoLanguageOrder.join(","), normalizeOnlyLanguages: config.normalizeOnlyLanguages.join(","),
    removeOtherLanguages: config.removeOtherLanguages, fallbackToUndetectedAudio: config.fallbackToUndetectedAudio,
    audioBitrate: config.audioBitrate, sampleRate: config.sampleRate, encodeSampleRate: config.forcedEncodeSampleRate || "",
    channels: String(args.inputs?.channels || "auto"), mp4CompatibleAudio: boolInput(args.inputs?.mp4CompatibleAudio, false) };
}

function planAudioValueSelection(args, sourceStreams) {
  const config = createPluginAudioConfig({ args: { ...args, inputs: args.inputs || {} }, useGpuSourcePort: true });
  const audioStreams = sourceStreams.filter(stream => stream.codec_type === "audio");
  // Planning is pure: paths name unused plans, never files or alternate outputs.
  const planned = buildAudioPlanContext({ ...config, args: { ...args, inputs: args.inputs || {} }, audioStreams,
    container: "mp4", durationSeconds: 1, workDir: path.dirname(args.inputFileObj._id), base: "value-proof",
     runId: "selection-only", tmpOutputFilePath: args.inputFileObj._id, debugLogging: false });
  return { config, planned };
}

function approveAudioValueMaps(args, maps, sourceStreams) {
  const { config, planned } = planAudioValueSelection(args, sourceStreams);
  const retained = planned.sourceAudioActions.filter(action => action.action !== "remove");
  const primary = maps.filter(map => !map.stereo);
  if (primary.length !== retained.length || new Set(primary.map(map => map.sourceIndex)).size !== primary.length
      || retained.some(action => !primary.some(map => map.sourceIndex === action.plan.sourceIdx))) {
    throw Error("Audio values do not cover the configured source selection");
  }
  const stereo = planned.audioPlans.filter(plan => plan.stereoFallback).map(plan => plan.sourceIdx);
  const actualStereo = maps.filter(map => map.stereo).map(map => map.sourceIndex);
  if (new Set(actualStereo).size !== actualStereo.length || actualStereo.some(index => !stereo.includes(index))
      || actualStereo.length !== stereo.length) {
    throw Error("Audio values do not cover the configured stereo generation");
  }
  return maps.map(map => {
    const action = planned.sourceAudioActions.find(action => action.plan.sourceIdx === map.sourceIndex);
    if (!action || (normalizesAudio(map) && action.action !== "normalize")) throw Error("Unrequested normalization");
    if (action.action !== "normalize") return map;
    if (config.audioBitrate.toLowerCase() !== "192k" || config.forcedEncodeSampleRate) {
      throw Error("Configured encoding lacks the independent CPU parity contract");
    }
    const source = sourceStreams.filter(stream => stream.codec_type === "audio")[map.sourceIndex];
    const compatibility = (boolInput(args.inputs?.mp4CompatibleAudio, false)
      || path.extname(args.inputFileObj._id).toLowerCase() === ".mp4") && shouldEncodeCopiedAudioForMp4("mp4", source);
    return { ...map, kind: map.stereo || (compatibility && ["encode", "normalizeAac"].includes(map.kind)) ? "normalizeAac" : "normalize", inputs: { i: String(config.targetI), lra: String(config.targetLra),
      tp: String(config.targetTp), maxGain: String(config.maxGain) } };
  });
}

// Selection authority only. Counts, windows and CPU parity must still be proved;
// this data object never grants a clock or publication exemption.
function createAudioSelectionIntent(args, maps, sourceStreams) {
  validateValueMaps(maps);
  const intent = { schema: "media-audio-selection-intent.v1", sourceFile: args.inputFileObj._id,
    inputs: audioSelectionInputs(args),
    maps: approveAudioValueMaps(args, maps, sourceStreams) };
  approveAudioSelectionIntent(args, intent, sourceStreams);
  return intent;
}

function approveAudioSelectionIntent(args, intent, sourceStreams) {
  if (!intent || Object.keys(intent).sort().join() !== "inputs,maps,schema,sourceFile"
      || intent.schema !== "media-audio-selection-intent.v1" || intent.sourceFile !== args.inputFileObj._id
      || !path.isAbsolute(intent.sourceFile) || path.resolve(intent.sourceFile) !== intent.sourceFile
      || intent.sourceFile.includes("\0")) throw Error("Invalid original audio selection intent");
  assert.deepEqual(intent.inputs, audioSelectionInputs(args), "Audio selection intent differs from configured policy");
  validateValueMaps(intent.maps);
  const approved = approveAudioValueMaps(args, intent.maps, sourceStreams);
  assert.deepEqual(intent.maps, approved, "Audio selection intent differs from approved original mapping");
  return approved;
}

module.exports = { audioValueMaps, approveAudioValueMaps, audioSelectionInputs, planAudioValueSelection,
  createAudioSelectionIntent, approveAudioSelectionIntent };
