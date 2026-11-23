"use strict";

const path = require("node:path");
const { runTerminalWorker } = require("./pipelineTerminalWorker");
const { mediaTools } = require("./mediaTools");

async function rejectInferiorPublication(args) {
  const marker = args.variables.mediaPipeline;
  const result = await runTerminalWorker(args, {
    application: String(args.inputs.arr), file: args.inputFileObj._id,
    stagingRoot: path.dirname(path.dirname(marker.originalId)),
    completedRoot: String(args.inputs.outputDirectory), stateRoot: String(args.inputs.namingStateDirectory),
    activeJob: { source: marker.originalId, libraryId: marker.libraryId }, ffprobe: mediaTools(args).ffprobe,
    ...(args.variables.gpuNormalizeAudioNaming?.publicationPlan
      ? { publicationPlan: args.variables.gpuNormalizeAudioNaming.publicationPlan } : {}),
    completedRejection: { application: String(args.inputs.arr), host: String(args.inputs.arr_host),
      "apiKey": String(args.inputs.arr_api_key) },
  }, "qualityRejection");
  if (result.qualityRejected !== true) return null;
  if (result.nativeStatus !== "Failed" || result.removedPackage !== true || !result.auditAfter) {
    throw Error("Inferior publication cleanup was not acknowledged");
  }
  args.jobLog("Inferior completed download rejected and cleaned after native acknowledgement; existing library preserved.");
  return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: { ...args.variables,
    removeFromTdarr: true, mediaPipelineRejection: result } };
}

module.exports = { rejectInferiorPublication };
