"use strict";

const { runTerminalWorker } = require("./pipelineTerminalWorker");
const { mediaTools } = require("./mediaTools");

async function publishPackage(args, { resumeOnly = false, prepareRejection = false } = {}) {
  const rejection = args.variables?.gpuNormalizeAudioRejection;
  const beforeEvidence = args.variables?.mediaPipelineAudit?.beforeEvidence;
  const boundRejection = rejection && beforeEvidence ? { ...rejection,
    evidence: { ...rejection.evidence, processingBefore: beforeEvidence } } : rejection;
  if (resumeOnly && rejection) throw Error("Checkpoint admission cannot process an audio rejection");
  if (prepareRejection && !rejection) throw Error("Rejection evidence requires an actual rejection decision");
  if (rejection && args.variables.removeFromTdarr !== false) {
    throw Error("Download rejection requires deferred Tdarr removal");
  }
  const request = {
    fileObjects: { inputFileObj: args.inputFileObj, originalLibraryFile: args.originalLibraryFile },
    stagingRoot: args.librarySettings.folder, completedRoot: args.inputs.outputDirectory,
    stateRoot: args.inputs.namingStateDirectory,
    ...(rejection ? { rejection: boundRejection } : mediaTools(args)),
    ...(!rejection && !resumeOnly ? { replacement: args.variables?.mediaPipelineReplacement,
      processingAudit: args.variables?.mediaPipeline?.state === "finished" ? args.variables?.mediaPipelineAudit?.processingAudit
        : { beforeEvidence: args.variables?.mediaPipelineAudit?.beforeEvidence,
        audioExpectation: args.variables?.mediaPipelineAudioExpectation || null,
        audioOutcome: args.variables?.mediaPipelineAudio || null } } : {}),
    ...(resumeOnly ? { resumeOnly: true } : {}),
    ...(prepareRejection ? { prepareRejection: true } : {}),
  };
  args.jobLog(prepareRejection ? "Recording full input fingerprint and rejection evidence before downloader handoff."
    : rejection ? "Reporting rejected download before package and Tdarr removal."
      : "Verifying finished media and package ownership before rename and Move.");
  const result = await runTerminalWorker(args, request,
    prepareRejection ? "rejectionAudit" : rejection ? "rejection" : "publication");
  const valid = prepareRejection ? result.rejectionPrepared === true : rejection
    ? result.rejected === true && result.removedPackage === true && result.nativeStatus === "Failed"
    : resumeOnly ? typeof result.resumeFinished === "boolean" : Boolean(result.fileObjects?.inputFileObj?._id);
  if (!valid) throw Error("Finished package worker returned an invalid result");
  if (prepareRejection) return result;
  if (resumeOnly) {
    if (result.resumeFinished && (typeof result.output !== "string" || !result.replacement || !result.processingAudit)) {
      throw Error("Finished continuation lacks verified original retention");
    }
    args.jobLog(result.resumeFinished ? "Finished content checkpoint matched; skipping completed transcode and normalization."
      : "No matching finished checkpoint; normal processing continues.");
    return { outputFileObj: result.resumeFinished ? { ...args.inputFileObj, _id: result.output, file: result.output } : args.inputFileObj,
      outputNumber: result.resumeFinished ? 3 : 1,
      variables: result.resumeFinished ? { ...args.variables, mediaPipelineReplacement: result.replacement,
        mediaPipelineAudit: { beforeEvidence: result.processingAudit.beforeEvidence,
          processingAudit: result.processingAudit } } : args.variables };
  }
  if (rejection) return { outputFileObj: args.originalLibraryFile, outputNumber: 2,
    variables: { ...args.variables, removeFromTdarr: true,
      ...(result.auditAfter ? { mediaPipelineRejectionAudit: { before: result.auditBefore, after: result.auditAfter } } : {}) } };
  return { outputFileObj: result.fileObjects.inputFileObj, outputNumber: 1,
    variables: { ...args.variables, gpuNormalizeAudioNaming: result } };
}

module.exports = { publishPackage };
