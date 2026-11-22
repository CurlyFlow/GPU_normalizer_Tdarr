"use strict";

const path = require("node:path");
const { mediaTools } = require("./mediaTools");
const { verifyClockInWorker } = require("./mediaClockWorker");
const { audioClockMaps } = require("./audioClockMaps");
const { decoderIdentity } = require("./mediaEvidenceTools");
const { sourceClockTickForPreparation } = require("./pipelinePreparationMap");

async function verifyAudioOutputClock(args, candidateFile, audioSpecs, outputContract, eofContext = null) {
  try {
    const audioMap = audioClockMaps(args, audioSpecs, outputContract);
    const tools = mediaTools(args);
    const prober = decoderIdentity(tools.ffprobe);
    const sourceClockTick = sourceClockTickForPreparation(args, (prober.native || prober).executable);
    args.jobLog("Verifying original-relative clocks, copied video and copied audio samples before output handoff.");
    const receipt = await verifyClockInWorker({ sourceFile: args.inputFileObj._id, candidateFile,
      directory: path.dirname(candidateFile), ffmpegPath: tools.ffmpeg, ffprobePath: tools.ffprobe, audioMap, videoMap: null,
      ...(eofContext ? { eofContext } : {}),
      ...(sourceClockTick ? { sourceClockTick } : {}) },
    { onProgress: () => args.jobLog("Original-relative clock verification is still running; output remains unpublished.") });
    args.variables = { ...args.variables, gpuNormalizeAudioClock: receipt };
    const preparation = args.variables.mediaPipelinePreparationEvidence;
    if (args.variables.mediaPipeline && (!preparation || preparation.candidateFile !== args.inputFileObj._id
        || !preparation.inputs.some(input => input.file === args.inputFileObj._id
          && receipt.inputs.some(current => current.file === input.file
            && JSON.stringify(current.identity) === JSON.stringify(input.identity))))) {
      throw Object.assign(Error("Prepared input changed after admitted-original verification"), { code: "MEDIA_PREPARATION_HELD" });
    }
    if (receipt.status !== "pass") throw Object.assign(
      Error(`Original-relative media verification held: ${receipt.errors.slice(0, 3).join("; ")}`),
      { code: !receipt.clockErrors.length && receipt.copiedAudio.some(item => item.status !== "pass")
        ? "MEDIA_COPIED_AUDIO_HELD" : "MEDIA_CLOCK_HELD" });
    return receipt;
  } catch (error) {
    if (!["MEDIA_COPIED_AUDIO_HELD", "MEDIA_PREPARATION_HELD"].includes(error.code)) error.code = "MEDIA_CLOCK_HELD";
    error.preserveMediaEvidence = true;
    throw error;
  }
}

module.exports = { verifyAudioOutputClock };
