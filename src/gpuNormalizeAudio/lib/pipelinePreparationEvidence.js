"use strict";

const { requirePreparationMap } = require("./pipelinePreparationMap");
const { verifyClockInWorker } = require("./mediaClockWorker");
const { validateReceipt } = require("./mediaClockProtocol");
const { mediaTools } = require("./mediaTools");

function videoMap(mapping) {
  return mapping.streams.filter(stream => stream.type === "video")
    .map(stream => ({ sourceIndex: stream.sourceOrdinal, candidateIndex: stream.preparedOrdinal }));
}

function requirePreparationEvidence(args, contract) {
  const mapping = requirePreparationMap(args, contract);
  const receipt = args.variables.mediaPipelinePreparationEvidence;
  const selected = mapping.streams.filter(stream => stream.type === "audio");
  if (!receipt || receipt.status !== "pass" || receipt.sourceFile !== mapping.originalId
      || receipt.candidateFile !== mapping.preparedId || !Array.isArray(receipt.audioMap)
      || receipt.audioMap.length !== selected.length || receipt.audioMap.some((map, index) => {
        const stream = selected[index];
        return map.id !== `prepare-a${index}` || map.sourceIndex !== stream.sourceOrdinal
          || map.candidateIndex !== stream.preparedOrdinal || map.compareSamples !== true || map.sampleBytes !== 8;
      })) throw Error("Missing or foreign preparation content/clock proof");
  validateReceipt(receipt, { sourceFile: mapping.originalId, candidateFile: mapping.preparedId,
    audioMap: receipt.audioMap, videoMap: videoMap(mapping) });
  return receipt;
}

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
      directory, ffmpegPath: tools.ffmpeg, ffprobePath: tools.ffprobe, audioMap, videoMap: videoMap(mapping) },
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
