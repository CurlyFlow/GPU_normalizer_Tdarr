"use strict";

const path = require("path");
const { requirePreparationEvidence } = require("./pipelinePreparationEvidence");
const { retainAudioIntent } = require("./pipelineAudioIntent");
const SCHEMA = "media-pipeline.v1";
const VARIABLE = "mediaPipeline";

function absolute(value) {
  return typeof value === "string" && !value.includes("\0")
    && path.isAbsolute(value) && path.resolve(value) === value;
}

function holdUnprovenFinishedCheckpoint() {
  // Current finished checkpoints bind stored bytes, not an admitted original or
  // its intended transformations. Partial clock/copy receipts cannot upgrade them.
  throw Object.assign(new Error("Finished checkpoint lacks complete admitted-original integrity proof; media and evidence retained for explicit recovery"),
    { code: "MEDIA_INTEGRITY_HELD", preserveMediaEvidence: true });
}

function prepareContract(args, state) {
  const contract = { schema: SCHEMA, state,
    originalId: args.originalLibraryFile?._id, libraryId: args.originalLibraryFile?.DB,
    preparedId: args.inputFileObj?._id, completedDirectory: args.inputs.outputDirectory,
    stateDirectory: args.inputs.namingStateDirectory };
  args.variables = { ...args.variables, [VARIABLE]: contract };
  validateContract(args);
  return contract;
}

function validateContract(args) {
  const value = args.variables?.[VARIABLE];
  const keys = ["schema", "state", "originalId", "libraryId", "preparedId", "completedDirectory", "stateDirectory"];
  if (!value || Object.keys(value).sort().join() !== keys.sort().join()
      || value.schema !== SCHEMA || !["prepared", "finished"].includes(value.state)
      || ![value.originalId, value.preparedId, value.completedDirectory, value.stateDirectory].every(absolute)
      || typeof value.libraryId !== "string" || !value.libraryId
      || value.originalId !== args.originalLibraryFile?._id || value.libraryId !== args.originalLibraryFile?.DB) {
    throw new Error("Invalid or foreign media pipeline continuation");
  }
  if (value.state === "prepared") {
    requirePreparationEvidence(args, value);
  }
  return value;
}

function audioInput(args) {
  if (!args.variables?.[VARIABLE]) return null;
  const value = validateContract(args);
  if (value.state !== "prepared" || value.preparedId !== args.inputFileObj?._id) {
    throw new Error("Audio normalization requires the exact prepared input");
  }
  return value;
}

function audioResult(args, inputId, result, retain = retainAudioIntent) {
  if (!args.variables?.[VARIABLE]) return result;
  audioInput({ ...args, inputFileObj: { _id: inputId } });
  if (![1, 2].includes(result.outputNumber) || !absolute(result.outputFileObj?._id)) {
    throw new Error("Unsupported audio normalization outcome");
  }
  const intent = result.outputNumber === 1 ? retain(args, inputId, result) : null;
  return { ...result, variables: { ...result.variables,
    [VARIABLE]: args.variables[VARIABLE],
    mediaPipelinePreparation: args.variables.mediaPipelinePreparation,
    mediaPipelinePreparationEvidence: args.variables.mediaPipelinePreparationEvidence,
    mediaPipelinePreparationIntent: args.variables.mediaPipelinePreparationIntent,
    mediaPipelinePreparationPlan: args.variables.mediaPipelinePreparationPlan,
    mediaPipelineAudioIntent: intent,
    mediaPipelineAudio: { schema: SCHEMA, inputId, outputId: result.outputFileObj._id,
      outputNumber: result.outputNumber } } };
}

function finishContract(args) {
  const value = validateContract(args);
  if (value.completedDirectory !== args.inputs.outputDirectory
      || value.stateDirectory !== args.inputs.namingStateDirectory) {
    throw new Error("Media pipeline continuation changed its publication scope");
  }
  if (value.state === "finished") {
    if (args.inputFileObj?._id !== value.preparedId || args.variables.mediaPipelineAudio) {
      throw new Error("Finished checkpoint must bypass audio normalization");
    }
    const retained = args.variables.mediaPipelineReplacement;
    if (!retained || !absolute(retained.file) || !retained.identity) holdUnprovenFinishedCheckpoint();
    // The terminal consumer revalidates this private retained-original binding
    // under exact job ownership before publication. Never run audio/video again.
    return false;
  }
  const audio = args.variables.mediaPipelineAudio;
  if (!audio || Object.keys(audio).sort().join() !== "inputId,outputId,outputNumber,schema"
      || audio.schema !== SCHEMA || audio.inputId !== value.preparedId
      || audio.outputId !== args.inputFileObj?._id || ![1, 2].includes(audio.outputNumber)) {
    throw new Error("Missing or foreign audio normalization outcome");
  }
  return audio.outputNumber === 2;
}

module.exports = { prepareContract, validateContract, audioInput, audioResult, finishContract, holdUnprovenFinishedCheckpoint };
