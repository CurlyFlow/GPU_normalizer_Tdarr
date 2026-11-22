"use strict";

const path = require("node:path");
const { mediaTools } = require("./mediaTools");
const { audioClockMaps } = require("./audioClockMaps");
const { transportAudioInWorker } = require("./mediaAudioTransportWorker");
const { decoderIdentity } = require("./mediaEvidenceTools");
const { sourceClockTickForPreparation } = require("./pipelinePreparationMap");

async function transportAudioOutput(args, candidateFile, audioSpecs, outputContract, eofContext = null) {
  try {
    const tools = mediaTools(args);
    const prober = decoderIdentity(tools.ffprobe);
    const sourceClockTick = sourceClockTickForPreparation(args, (prober.native || prober).executable);
    const receipt = await transportAudioInWorker({ sourceFile: args.inputFileObj._id, candidateFile,
      directory: path.dirname(candidateFile), ffmpegPath: tools.ffmpeg, ffprobePath: tools.ffprobe,
      audioMap: audioClockMaps(args, audioSpecs, outputContract), videoMap: null,
      ...(eofContext ? { eofContext } : {}),
      ...(sourceClockTick ? { sourceClockTick } : {}) },
    { onProgress: () => args.jobLog("Original-clock packet transport is still running; output remains unpublished.") });
    args.variables = { ...args.variables, gpuNormalizeAudioTransport: receipt };
    if (receipt.status !== "pass") throw Error(`Audio clock transport held: ${receipt.errors.slice(0, 3).join("; ")}`);
    return receipt.output.file;
  } catch (error) {
    error.code = "MEDIA_CLOCK_TRANSPORT_HELD"; error.preserveMediaEvidence = true;
    throw error;
  }
}

module.exports = { transportAudioOutput };
