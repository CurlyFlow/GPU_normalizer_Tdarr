"use strict";

const path = require("node:path");
const { audioSelectionInputs } = require("./audioValueSelection");
const { fileDigest, sameFileGeneration, retainedReceipt, writePrivateReceipt } = require("./mediaEvidenceFiles");

function retainAudioIntent(args, inputId, result) {
  const prepared = args.variables.mediaPipelinePreparationIntent;
  if (!prepared || prepared.schema !== "media-preparation-intent.v1" || prepared.status !== "pass"
      || prepared.preparedId !== inputId) throw Error("Audio outcome lacks its admitted preparation intent");
  const preparation = retainedReceipt(prepared);
  const source = { file: inputId, identity: fileDigest(inputId) };
  if (!sameFileGeneration(prepared.inputs.find(input => input.file === inputId)?.identity, source.identity)) {
    throw Error("Prepared audio input changed before outcome retention");
  }
  const outputId = result.outputFileObj._id;
  const handoff = result.variables?.gpuNormalizeAudioHandoff;
  if (outputId !== inputId && (!handoff || handoff.source?.file !== inputId || handoff.candidate?.file !== outputId)) {
    throw Error("Changed audio output lacks its verified rename handoff");
  }
  const candidate = { file: outputId, identity: fileDigest(outputId) };
  if (outputId !== inputId && (!sameFileGeneration(handoff.source.identity, source.identity)
      || !sameFileGeneration(handoff.candidate.identity, candidate.identity))) throw Error("Audio handoff generation changed");
  // Passthrough may still point at the download itself. Evidence belongs to
  // the preparation worker's cache, never inside an importer-visible package.
  const directory = path.dirname(path.dirname(preparation.file));
  const packageDirectory = path.dirname(args.originalLibraryFile._id);
  if (directory === packageDirectory || directory.startsWith(`${packageDirectory}${path.sep}`)) {
    throw Error("Audio intent storage must be outside the media package");
  }
  return writePrivateReceipt(directory, "media-audio-intent", {
    schema: "media-audio-intent.v1", scope: "executed-audio-policy-and-handoff", status: "pass",
    source, candidate, inputs: audioSelectionInputs(args), preparation,
    handoff: outputId === inputId ? null : retainedReceipt(handoff) });
}

module.exports = { retainAudioIntent };
