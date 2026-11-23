"use strict";

const { retainedReceipt } = require("./mediaEvidenceFiles");
const { verifyFinishInWorker } = require("./pipelineFinishWorker");

async function verifyFinish(args, settings, directory, tools) {
  try {
    const continuation = args.variables.mediaPipeline;
    const request = { originalFile: continuation.originalId, preparedFile: continuation.preparedId,
      audioFile: args.variables.mediaPipelineAudio.outputId, candidateFile: args.inputFileObj._id,
      libraryId: continuation.libraryId, stagingRoot: args.librarySettings.folder,
      completedRoot: continuation.completedDirectory, stateRoot: continuation.stateDirectory,
      directory, settings, preparation: retainedReceipt(args.variables.mediaPipelinePreparationIntent),
      audioIntent: retainedReceipt(args.variables.mediaPipelineAudioIntent),
      videos: (args.variables.mediaPipelineVideo || []).map(retainedReceipt), ffmpegPath: tools.ffmpeg, ffprobePath: tools.ffprobe };
    args.jobLog("Verifying complete admitted-original transformations before replacement or publication.");
    const receipt = await verifyFinishInWorker(request, {
      onProgress: () => args.jobLog("Complete finish verification is still running; original remains unchanged.") });
    args.variables.mediaPipelineIntegrity = receipt;
    if (receipt.status !== "pass") throw Error(`Complete integrity held: ${receipt.errors.slice(0, 3).join("; ")}`);
    return receipt;
  } catch (error) {
    error.code = "MEDIA_INTEGRITY_HELD";
    error.preserveMediaEvidence = true;
    throw error;
  }
}

module.exports = { verifyFinish };
