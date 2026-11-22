"use strict";

const { requirePreparationMap, preparationVideoMap, requirePreparationEvidence } = require("./pipelinePreparationMap");
const { verifyClockInWorker } = require("./mediaClockWorker");
const { mediaTools } = require("./mediaTools");

async function verifyPreparationEvidence(args, directory) {
  try {
    const mapping = requirePreparationMap(args, { originalId: args.originalLibraryFile._id, preparedId: args.inputFileObj._id });
    const audio = args.inputFileObj.ffProbeData.streams.filter(stream => stream.codec_type === "audio");
    const audioMap = mapping.streams.filter(stream => stream.type === "audio").map((stream, index) => ({
      id: `prepare-a${index}`, sourceIndex: stream.sourceOrdinal, candidateIndex: stream.preparedOrdinal,
      channels: Number(audio[stream.preparedOrdinal]?.channels), rate: Number(audio[stream.preparedOrdinal]?.sample_rate),
      sampleBytes: 8, compareSamples: true,
    }));
    const tools = mediaTools(args);
    args.jobLog("Verifying prepared stream copies against the admitted original before audio processing.");
    const receipt = await verifyClockInWorker({ sourceFile: mapping.originalId, candidateFile: mapping.preparedId,
      directory, ffmpegPath: tools.ffmpeg, ffprobePath: tools.ffprobe, audioMap, videoMap: preparationVideoMap(mapping) },
    { onProgress: () => args.jobLog("Preparation verification is still running; original remains unchanged.") });
    args.variables = { ...args.variables, mediaPipelinePreparationEvidence: receipt };
    if (receipt.status !== "pass") throw Error(`Preparation verification held: ${receipt.errors.slice(0, 3).join("; ")}`);
    return requirePreparationEvidence(args, { originalId: mapping.originalId, preparedId: mapping.preparedId });
  } catch (error) {
    error.code = "MEDIA_PREPARATION_HELD";
    error.preserveMediaEvidence = true;
    throw error;
  }
}

module.exports = { verifyPreparationEvidence, requirePreparationEvidence };
