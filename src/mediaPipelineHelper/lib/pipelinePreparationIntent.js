"use strict";

const path = require("node:path");
const { fileDigest, sameFileGeneration, retainedReceipt, writePrivateReceipt } = require("./mediaEvidenceFiles");
const { requirePreparationEvidence } = require("./pipelinePreparationEvidence");
const { inspectStreams } = require("./mediaSourceProbe");
const { decoderIdentity } = require("./mediaEvidenceTools");
const { planPreparation } = require("./pipelinePreparation");
const { mediaTools } = require("./mediaTools");
const { pipelineSettings } = require("./pipelineSettings");
const { bindSubtitleExtractions } = require("./pipelineSubtitleEvidence");

function retainPreparationIntent(args, settings, directory) {
  const contract = { originalId: args.originalLibraryFile._id, preparedId: args.inputFileObj._id };
  const proof = requirePreparationEvidence(args, contract), mapping = args.variables.mediaPipelinePreparation;
  const actual = args.variables.mediaPipelinePreparationPlan;
  if (!actual || Object.keys(actual).sort().join() !== "extractionFailed,sourceId,subtitles"
      || typeof actual.extractionFailed !== "boolean" || actual.sourceId !== mapping.sourceId
      || JSON.stringify(settings) !== JSON.stringify(pipelineSettings(args.inputs))) {
    throw Error("Preparation lacks its executed policy manifest");
  }
  const prober = decoderIdentity(mediaTools(args).ffprobe);
  const sourceInput = { file: mapping.sourceId, identity: fileDigest(mapping.sourceId) };
  if (JSON.stringify(prober) !== JSON.stringify(proof.prober)
      || JSON.stringify(decoderIdentity(mediaTools(args).ffmpeg)) !== JSON.stringify(proof.decoder)) {
    throw Error("Preparation tools changed before policy retention");
  }
  const original = { _id: contract.originalId, container: path.extname(contract.originalId).slice(1),
    ffProbeData: { streams: inspectStreams(contract.originalId, (prober.native || prober).executable) } };
  const plan = planPreparation(original, original._id, settings);
  if (JSON.stringify(actual.subtitles) !== JSON.stringify(bindSubtitleExtractions(plan.subtitleTargets, actual.extractionFailed))) {
    throw Error("Preparation subtitle bindings differ from their executed inventory");
  }
  if (JSON.stringify(plan.retainedStreamIndices) !== JSON.stringify(mapping.streams.map(stream => stream.sourceIndex))) {
    throw Error("Prepared streams differ from the admitted cleanup policy");
  }
  if ([...proof.inputs, sourceInput].some(input => !sameFileGeneration(input.identity, fileDigest(input.file)))) {
    throw Error("Preparation changed before intent retention");
  }
  const receipt = writePrivateReceipt(directory, "media-preparation-intent", {
    schema: "media-preparation-intent.v1", scope: "admitted-policy-and-preparation", status: "pass",
    originalId: contract.originalId, preparedId: contract.preparedId, settings, actual,
    mapping, sourceInput, inputs: proof.inputs, evidence: retainedReceipt(proof), decoder: proof.decoder, prober: proof.prober });
  args.variables.mediaPipelinePreparationIntent = receipt;
  return receipt;
}

module.exports = { retainPreparationIntent };
