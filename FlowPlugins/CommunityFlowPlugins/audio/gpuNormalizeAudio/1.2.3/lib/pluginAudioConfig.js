"use strict";

const {
  boolInput,
  intNum,
  num,
} = require("./common");
const {
  normalizeOnlyLanguageOrder,
  stereoFallbackLanguageOrder,
} = require("./audioLanguageOrder");

function createPluginAudioConfig({
  args,
  useGpuSourcePort,
}) {
  const defaultChunkMiB = String(process.env.LOUDNORM_GPU_CHUNK_MIB || "1").trim() || "1";
  const stereoFallbackChunkMiB = String(process.env.LOUDNORM_GPU_STEREO_FALLBACK_CHUNK_MIB || "").trim();
  const stereoFallbackApplyChunkMiB = String(process.env.LOUDNORM_GPU_STEREO_FALLBACK_APPLY_CHUNK_MIB || "").trim();
  const originalApplyChunkMiB = String(process.env.LOUDNORM_GPU_ORIGINAL_APPLY_CHUNK_MIB || "").trim();

  const sampleRate = intNum(args.inputs.sampleRate, 192000);
  const encodeSampleRateInput = String(args.inputs.encodeSampleRate || "").trim();
  const forcedEncodeSampleRate = encodeSampleRateInput ? intNum(encodeSampleRateInput, sampleRate) : 0;
  const targetI = num(args.inputs.i, -18.0);
  const targetLra = num(args.inputs.lra, 7.0);
  const targetTp = num(args.inputs.tp, -2.0);
  const maxGain = num(args.inputs.maxGain, 15);
  const ensureStereo = boolInput(args.inputs.ensureStereo, true);
  const stereoFallbackFirstOnly = boolInput(args.inputs.stereoFallbackFirstOnly, true);
  const stereoLanguageOrder = stereoFallbackLanguageOrder(args.inputs.stereoFallbackOrder);
  const normalizeOnlyLanguages = normalizeOnlyLanguageOrder(args.inputs.normalizeOnlyLanguages);
  const removeOtherLanguages = boolInput(args.inputs.removeOtherLanguages, true);
  const audioBitrate = String(args.inputs.audioBitrate || "192k").replace(/[^0-9kKmM]/g, "") || "192k";
  const encodeThreadsInput = String(process.env.LOUDNORM_GPU_ENCODE_THREADS || "2").trim();
  const encodeThreadArgs = (plan = null) => {
    const specificInput = plan
      ? (plan.stereoFallback ? (process.env.LOUDNORM_GPU_STEREO_FALLBACK_ENCODE_THREADS ?? "1") : process.env.LOUDNORM_GPU_ORIGINAL_ENCODE_THREADS)
      : undefined;
    const threadInput = String(specificInput !== undefined ? specificInput : encodeThreadsInput).trim();
    if (!threadInput) return [];
    return ["-threads", String(Math.max(0, Math.min(64, intNum(threadInput, 0))))];
  };
  const gpuInputFormat = useGpuSourcePort ? "f64le" : "f32le";
  const gpuInputExt = useGpuSourcePort ? "f64" : "f32";
  const gpuOutputFormat = useGpuSourcePort ? "f64le" : "f32le";
  const gpuOutputExt = useGpuSourcePort ? "f64" : "f32";
  const useStreamingSourcePort = useGpuSourcePort;

  return {
    audioBitrate,
    defaultChunkMiB,
    encodeThreadArgs,
    ensureStereo,
    forcedEncodeSampleRate,
    gpuInputExt,
    gpuInputFormat,
    gpuOutputExt,
    gpuOutputFormat,
    maxGain,
    normalizeOnlyLanguages,
    originalApplyChunkMiB,
    removeOtherLanguages,
    sampleRate,
    stereoFallbackApplyChunkMiB,
    stereoFallbackChunkMiB,
    stereoFallbackFirstOnly,
    stereoLanguageOrder,
    targetI,
    targetLra,
    targetTp,
    useStreamingSourcePort,
  };
}

module.exports = {
  createPluginAudioConfig,
};
