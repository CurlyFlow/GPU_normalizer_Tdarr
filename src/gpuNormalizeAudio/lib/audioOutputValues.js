"use strict";

const path = require("node:path");
const { mediaTools } = require("./mediaTools");
const { verifyAudioValuesInWorker } = require("./mediaAudioValueWorker");
const { CPU_PLUGIN_SHA256, normalizesAudio } = require("./mediaAudioValueProtocol");
const { audioValueMaps, createAudioSelectionIntent } = require("./audioValueSelection");
const { inspectStreams } = require("./mediaSourceProbe");
const { decoderIdentity } = require("./mediaEvidenceTools");
const { retainedReceipt } = require("./mediaEvidenceFiles");

async function compareAudioOutputValues(args, candidateFile, audioSpecs, outputContract, basis, verify) {
  const tools = mediaTools(args), prober = decoderIdentity(tools.ffprobe);
  const sourceStreams = inspectStreams(args.inputFileObj._id, (prober.native || prober).executable);
  const { maps } = createAudioSelectionIntent(args, audioValueMaps(args, audioSpecs, outputContract), sourceStreams);
  args.jobLog(basis === null
    ? "Observing complete native audio values against independent CPU references; output remains unpublished."
    : "Rechecking complete native audio values against the same CPU references before output handoff.");
  const receipt = await verify({ sourceFile: args.inputFileObj._id, candidateFile,
    directory: path.dirname(candidateFile), ffmpegPath: tools.ffmpeg, ffprobePath: tools.ffprobe, maps,
    plugin: maps.some(normalizesAudio)
      ? { file: path.resolve(__dirname, "../../../normalizeAudio/1.0.0/index.js"), sha256: CPU_PLUGIN_SHA256 } : null,
    ...(basis === null ? {} : { basis }) },
  { onProgress: () => args.jobLog("Independent audio value comparison is still running; output remains unpublished.") });
  args.variables = { ...args.variables, gpuNormalizeAudioValues: receipt };
  if (receipt.status !== "pass") {
    for (const result of receipt.results.slice(0, 4)) {
      const pcm = value => Object.fromEntries(["format", "bytes", "samples", "sha256", "finite", "aligned"]
        .map(key => [key, value?.[key] ?? null]));
      args.jobLog(`GPU Normalize Audio value evidence: ${JSON.stringify({ id: result.id, kind: result.kind,
        settings: maps.find(map => map.id === result.id)?.inputs || null,
        measurement: result.reference?.measurement || null,
        values: (result.values || []).slice(0, 1).map(pair => ({ source: pcm(pair.source), candidate: pcm(pair.candidate) })) })}`);
    }
    throw Error(`Independent audio value verification held: ${receipt.errors.slice(0, 3).join("; ")}`);
  }
  return receipt;
}

async function observeAudioOutputValues(args, candidateFile, audioSpecs, outputContract, verify = verifyAudioValuesInWorker) {
  try {
    return retainedReceipt(await compareAudioOutputValues(args, candidateFile, audioSpecs, outputContract, null, verify));
  } catch (error) {
    error.code = "MEDIA_AUDIO_VALUES_HELD";
    error.preserveMediaEvidence = true;
    throw error;
  }
}

async function verifyAudioOutputValues(args, candidateFile, audioSpecs, outputContract, basis, verify = verifyAudioValuesInWorker) {
  try {
    if (!basis) throw Error("Final audio values require the first-candidate reference");
    const receipt = await compareAudioOutputValues(args, candidateFile, audioSpecs, outputContract, basis, verify);
    const clock = args.variables.gpuNormalizeAudioClock;
    if (!clock || clock.status !== "pass" || clock.sourceFile !== args.inputFileObj._id || clock.candidateFile !== candidateFile
        || clock.inputs.length !== receipt.inputs.length || clock.inputs.some(input => !receipt.inputs.some(current =>
          current.file === input.file && JSON.stringify(current.identity) === JSON.stringify(input.identity)))
        || JSON.stringify(clock.decoder) !== JSON.stringify(receipt.decoder)
        || JSON.stringify(clock.prober) !== JSON.stringify(receipt.prober)) throw Error("Clock and audio values do not bind the same media/tool generation");
    return receipt;
  } catch (error) {
    error.code = "MEDIA_AUDIO_VALUES_HELD";
    error.preserveMediaEvidence = true;
    throw error;
  }
}

module.exports = { observeAudioOutputValues, verifyAudioOutputValues };
