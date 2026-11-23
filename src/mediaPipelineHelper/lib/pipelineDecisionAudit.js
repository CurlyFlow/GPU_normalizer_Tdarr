"use strict";

const path = require("node:path");
const { runTerminalWorker } = require("./pipelineTerminalWorker");

async function recordProcessingDecision(args, stage, expected) {
  const previous = args.variables.mediaPipelineAudit;
  const marker = args.variables.mediaPipeline;
  const finished = stage === "published" && marker?.state === "finished";
  if (finished && !previous?.processingAudit) throw Error("Finished continuation lacks its original processing context");
  const audio = finished ? previous.processingAudit : {
    beforeEvidence: previous?.beforeEvidence,
    audioExpectation: args.variables.mediaPipelineAudioExpectation || null,
    audioOutcome: args.variables.mediaPipelineAudio || null,
  };
  const decisionAudit = stage === "admission" ? { stage, expected }
    : { stage, ...audio,
      ...(stage === "published" && args.variables.gpuNormalizeAudioNaming?.publicationPlan
        ? { publicationPlan: args.variables.gpuNormalizeAudioNaming.publicationPlan } : {}),
      ...(stage === "rejected" ? { rejectionAfter: args.variables.mediaPipelineRejectionAudit?.after } : {}) };
  const result = await runTerminalWorker(args, {
    fileObjects: { inputFileObj: args.inputFileObj, originalLibraryFile: args.originalLibraryFile },
    stagingRoot: path.dirname(path.dirname(marker?.originalId || args.originalLibraryFile._id)),
    completedRoot: String(args.inputs.outputDirectory), stateRoot: String(args.inputs.namingStateDirectory), decisionAudit,
  }, "processingAudit");
  if (result.audited !== true || !result.beforeEvidence) throw Error("Processing evidence was not retained");
  args.variables = { ...args.variables, mediaPipelineAudit: { ...previous, ...result } };
}

module.exports = { recordProcessingDecision };
