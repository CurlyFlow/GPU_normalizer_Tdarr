"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fileDigest, sameFileGeneration } = require("./mediaEvidenceFiles");
const { inspectStreams } = require("./mediaSourceProbe");
const { verifyCopiedAudio } = require("./mediaCopiedAudio");
const { stereoReferenceRecipe, singleAudioReferenceRecipe } = require("./mediaAudioReferenceRecipe");
const { loadCpuReferencePlugin, referenceEnvironment, beginReference, finishReference } = require("./mediaReferenceProof");
const { requireReferenceCapacity } = require("./mediaAudioReferenceCapacity");
const { normalizesAudio } = require("./mediaAudioValueProtocol");

function referenceMeasurement(line) {
  if (typeof line !== "string" || line.length > 4096 || !line.startsWith("Loudnorm first pass values returned:")) return null;
  try {
    const values = JSON.parse(line.slice(line.indexOf("{")));
    return Object.fromEntries(["input_i", "input_tp", "input_lra", "input_thresh", "output_i", "output_tp",
      "output_lra", "output_thresh", "normalization_type", "target_offset"]
      .filter(key => typeof values[key] === "string" && values[key].length <= 64).map(key => [key, values[key]]));
  } catch { return null; }
}

function prepareReference(ffmpeg, args, output) {
  const result = spawnSync(ffmpeg, [...args, output], { encoding: "utf8", timeout: 900000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error("Independent audio reference preparation incomplete");
  fs.chmodSync(output, 0o600);
}

async function compareValues(sourceFile, candidateFile, sourceIndex, map, tools) {
  const sourceStreams = inspectStreams(sourceFile, tools.ffprobe), candidateStreams = inspectStreams(candidateFile, tools.ffprobe);
  const source = sourceStreams.filter(stream => stream.type === "audio")[sourceIndex];
  const candidate = candidateStreams.filter(stream => stream.type === "audio")[map.candidateIndex];
  if (!source || !candidate || String(source.channel_layout || "") !== String(candidate.channel_layout || "")
      || Number(source.sample_rate) !== Number(candidate.sample_rate)) throw Error("Independent audio native layout or rate changed");
  return await verifyCopiedAudio({ sourceFile, candidateFile, ffmpegPath: tools.ffmpeg,
    sourceStreams, candidateStreams,
    audioMap: [{ id: map.id, sourceIndex, candidateIndex: map.candidateIndex, compareSamples: true }] });
}

function requireCandidateCoverage(request, map, tools) {
  const audio = inspectStreams(request.candidateFile, tools.ffprobe).filter(stream => stream.type === "audio");
  if (audio.length !== request.maps.length || Number(audio[map.candidateIndex]?.channels) !== map.channels) {
    throw Error("Candidate audio transform coverage or channels changed");
  }
}

function audioReferenceInputs(result) {
  const comparison = result.comparisonReference;
  const inputs = [{ file: comparison.file, identity: comparison.identity }];
  if (normalizesAudio(result)) {
    const proof = result.reference;
    const environment = proof.inputs.reference_inputs;
    inputs.push({ file: environment.source_file, identity: environment.source }, proof.prepared_input, proof.output,
      ...environment.modules.map(([file, identity]) => ({ file, identity })));
    if (result.composition) inputs.push(...result.composition.inputs, result.composition.output);
  }
  return inputs;
}

async function recompareAudioValueMap(request, map, previous, tools) {
  const evidence = { ...previous, status: "held", errors: [] };
  try {
    requireCandidateCoverage(request, map, tools);
    const reference = evidence.comparisonReference;
    evidence.values = await compareValues(reference.file, request.candidateFile, reference.audioIndex, map, tools);
    if (audioReferenceInputs(evidence).some(input => !sameFileGeneration(input.identity, fileDigest(input.file)))) {
      throw Error("Audio comparison reference changed during re-comparison");
    }
    evidence.errors.push(...evidence.values.flatMap(value => value.errors));
    if (!evidence.errors.length) evidence.status = "pass";
  } catch (error) { evidence.errors.push(error.message); }
  return evidence;
}

async function createNormalizationReference(request, map, directory, tools) {
  if (fileDigest(request.plugin.file).sha256 !== request.plugin.sha256) throw Error("Independent CPU normalizer bytes changed");
  const { cpu, roots } = loadCpuReferencePlugin(request.plugin.file);
  const streams = inspectStreams(request.sourceFile, tools.ffprobe);
  const originalAudio = streams.filter(stream => stream.type === "audio");
  const source = originalAudio[map.sourceIndex];
  if (!source || (!map.stereo && Number(source.channels) !== map.channels)) throw Error("Unsupported normalized channel transform");
  const environment = referenceEnvironment(request.sourceFile, request.plugin.file, request.ffmpegPath, roots);
  let prepared = request.sourceFile, recipe = { kind: "admitted-original" };
  if (map.stereo || originalAudio.length !== 1 || map.sourceIndex !== 0) {
    const ext = map.stereo && [".mov", ".mkv"].includes(path.extname(request.sourceFile)) ? path.extname(request.sourceFile) : ".mkv";
    prepared = path.join(directory, `reference-input${ext}`);
    const spec = map.stereo ? stereoReferenceRecipe(request.sourceFile, prepared, map.sourceIndex)
      : singleAudioReferenceRecipe(request.sourceFile, map.sourceIndex);
    if (!map.stereo) prepared = path.join(directory, `reference-input${spec.extension}`);
    recipe = spec.recipe;
    prepareReference(tools.ffmpeg, spec.args, prepared);
    if (!map.stereo) {
      const values = await compareValues(request.sourceFile, prepared, map.sourceIndex, { ...map, candidateIndex: 0 }, tools);
      if (values.some(value => value.status !== "pass")) throw Error("Isolated CPU reference changed admitted samples");
    }
  }
  const start = beginReference({ reference_inputs: environment, source_audio_index: map.sourceIndex,
    settings: map.inputs, stereo: map.stereo, recipe }, prepared, request.ffmpegPath);
  const referenceWork = path.join(directory, "cpu-oracle");
  fs.mkdirSync(referenceWork, { mode: 0o700 });
  let measurement = null;
  const result = await cpu.plugin({ inputFileObj: { _id: prepared, ffProbeData: { streams: inspectStreams(prepared, tools.ffprobe) } },
    inputs: { ...map.inputs }, ffmpegPath: request.ffmpegPath, platform: process.platform, workerType: "transcodecpu",
    workDir: referenceWork, variables: {}, deps: { fsextra: { ensureDirSync: dir => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) } },
    jobLog(line) { measurement = referenceMeasurement(line) || measurement; }, logFullCliOutput: false, updateWorker() {} });
  if (result.outputNumber !== 1 || typeof result.outputFileObj?._id !== "string") throw Error("Unsupported CPU reference outcome");
  const output = result.outputFileObj._id;
  if (output !== prepared && (!path.resolve(output).startsWith(referenceWork + path.sep) || fs.realpathSync(output) !== output)) {
    throw Error("CPU reference output escapes its private verifier directory");
  }
  const proof = finishReference(start, output, request.ffmpegPath);
  proof.measurement = measurement;
  if (fileDigest(request.plugin.file).sha256 !== request.plugin.sha256) throw Error("Independent CPU normalizer changed during execution");
  return { output, proof };
}

async function verifyAudioValueMap(request, map, directory, tools) {
  const evidence = { id: map.id, kind: map.kind, status: "held", errors: [] };
  try {
    requireCandidateCoverage(request, map, tools);
    requireReferenceCapacity(request, map, directory, tools.ffprobe);
    let reference = request.sourceFile, referenceIndex = map.sourceIndex;
    if (normalizesAudio(map)) {
      const result = await createNormalizationReference(request, map, directory, tools);
      reference = result.output;
      referenceIndex = 0;
      evidence.reference = result.proof;
      if (map.kind === "normalizeAac") {
        evidence.composition = null;
        if (result.proof.output.file === result.proof.prepared_input.file) {
          const container = path.extname(request.candidateFile).toLowerCase();
          if (![".mkv", ".mp4", ".mov", ".m4a"].includes(container)) throw Error("Unsupported compatibility reference container");
          const binding = file => ({ file, identity: fileDigest(file) });
          const inputs = [result.proof.output];
          const encoded = path.join(directory, map.stereo ? "skipped-stereo.m4a" : `skipped-audio${container}`);
          prepareReference(tools.ffmpeg, ["-v", "error", "-nostdin", "-n", "-i", reference,
            "-map", "0:a:0", "-c:a", "aac", "-b:a", "192k"], encoded);
          reference = encoded;
          if (map.stereo) {
            inputs.push(binding(encoded));
            reference = path.join(directory, `skipped-stereo-mux${container}`);
            prepareReference(tools.ffmpeg, ["-v", "error", "-nostdin", "-n", "-i", encoded,
              "-map", "0:a:0", "-c:a", "copy"], reference);
          }
          evidence.composition = { source: result.proof.output, inputs, output: binding(reference),
            codec: "aac", bitrate: "192k", stereo: map.stereo, container };
        }
      }
    } else if (map.kind === "encode") {
      const container = path.extname(request.candidateFile).toLowerCase();
      if (![".mkv", ".mp4", ".mov", ".m4a"].includes(container)) throw Error("Unsupported compatibility reference container");
      reference = path.join(directory, `compatibility-reference${container}`);
      prepareReference(tools.ffmpeg, ["-v", "error", "-nostdin", "-n", "-i", request.sourceFile,
        "-map", `0:a:${map.sourceIndex}`, "-c:a", "aac", "-b:a", "192k"], reference);
      evidence.reference = { source: fileDigest(request.sourceFile), output: fileDigest(reference), codec: "aac", bitrate: "192k" };
      referenceIndex = 0;
    }
    evidence.comparisonReference = { file: reference, identity: fileDigest(reference), audioIndex: referenceIndex };
    evidence.values = await compareValues(reference, request.candidateFile, referenceIndex, map, tools);
    if (audioReferenceInputs(evidence).some(input => !sameFileGeneration(input.identity, fileDigest(input.file)))) {
      throw Error("Audio comparison reference changed during verification");
    }
    evidence.errors.push(...evidence.values.flatMap(value => value.errors));
    if (!evidence.errors.length) evidence.status = "pass";
  } catch (error) { evidence.errors.push(error.message); }
  return evidence;
}

module.exports = { verifyAudioValueMap, recompareAudioValueMap, audioReferenceInputs, referenceMeasurement };
