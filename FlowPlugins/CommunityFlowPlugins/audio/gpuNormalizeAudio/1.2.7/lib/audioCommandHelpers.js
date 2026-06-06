"use strict";

const {
  envFlag,
  intNum,
  loudnormNumber,
  q,
} = require("./common");

function createAudioCommandHelpers({
  args,
  sampleRate,
  forcedEncodeSampleRate,
  targetI,
  targetLra,
  targetTp,
  defaultChunkMiB,
  stereoFallbackChunkMiB,
  stereoFallbackApplyChunkMiB,
  originalApplyChunkMiB,
  sourceChannelsFor,
  needsInlineStereoDownmix,
  cpuLoudnormNice,
}) {
  const loudnormFilter = () => `loudnorm=I=${targetI}:LRA=${targetLra}:TP=${targetTp}:print_format=json`;
  const loudnessSummary = (values) => `input ${loudnormNumber(values, "input_i").toFixed(2)} LUFS, true peak ${loudnormNumber(values, "input_tp").toFixed(2)} dBTP, target offset ${loudnormNumber(values, "target_offset").toFixed(2)} dB`;
  const skipMatchingOriginalAformat = envFlag("LOUDNORM_GPU_ORIGINAL_SKIP_MATCHING_AFORMAT", true);
  const canSkipOriginalAformat = (plan) => skipMatchingOriginalAformat && !plan.stereoFallback && plan.channelLayout && sourceChannelsFor(plan) === plan.channels;
  const cpuLoudnormFilter = (plan) => {
    const loudnorm = loudnormFilter();
    if (needsInlineStereoDownmix(plan)) return `aformat=channel_layouts=stereo,${loudnorm}`;
    return loudnorm;
  };
  const ffmpegLinearMode = (values) => {
    if (!values) return false;
    if (values._gpuFirstPass && envFlag("LOUDNORM_GPU_FIRST_PASS_FORCE_DYNAMIC", true)) return false;
    if (envFlag("LOUDNORM_GPU_FORCE_LINEAR_MODE")) return true;
    const measuredI = loudnormNumber(values, "input_i");
    const measuredLra = loudnormNumber(values, "input_lra");
    const measuredTp = loudnormNumber(values, "input_tp");
    const measuredThresh = loudnormNumber(values, "input_thresh");
    const linearOffset = targetI - measuredI;
    return measuredTp !== 99.0
      && measuredThresh !== -70.0
      && measuredLra !== 0.0
      && measuredI !== 0.0
      && measuredTp + linearOffset <= targetTp
      && measuredLra <= targetLra;
  };
  const processingSampleRateFor = (plan, values) => {
    const stereoFallbackSampleRate = Math.max(0, intNum(process.env.LOUDNORM_GPU_STEREO_FALLBACK_SAMPLE_RATE, 0));
    const originalSampleRate = Math.max(0, intNum(process.env.LOUDNORM_GPU_ORIGINAL_SAMPLE_RATE, 0));
    if (plan.stereoFallback && stereoFallbackSampleRate > 0) return stereoFallbackSampleRate;
    if (!plan.stereoFallback && originalSampleRate > 0) return originalSampleRate;
    if (!plan.stereoFallback && plan.sourceSampleRate > 0 && envFlag("LOUDNORM_GPU_ORIGINAL_SOURCE_PROCESS_RATE_ONLY")) return plan.sourceSampleRate;
    if (!plan.stereoFallback && plan.sourceSampleRate > 0 && envFlag("LOUDNORM_GPU_ORIGINAL_SOURCE_SAMPLE_RATE")) return plan.sourceSampleRate;
    if (!plan.stereoFallback && plan.sourceSampleRate > 0 && ffmpegLinearMode(values)) return plan.sourceSampleRate;
    return sampleRate;
  };
  const encodeSampleRateArgsFor = (plan, values) => {
    if (forcedEncodeSampleRate > 0) return ["-ar", String(forcedEncodeSampleRate)];
    const originalSampleRate = Math.max(0, intNum(process.env.LOUDNORM_GPU_ORIGINAL_SAMPLE_RATE, 0));
    if (!plan.stereoFallback && originalSampleRate > 0) return ["-ar", String(originalSampleRate)];
    if (!plan.stereoFallback && plan.sourceSampleRate > 0 && envFlag("LOUDNORM_GPU_ORIGINAL_SOURCE_PROCESS_RATE_ENCODE_DEFAULT") && envFlag("LOUDNORM_GPU_ORIGINAL_SOURCE_PROCESS_RATE_ONLY")) return ["-ar", String(Math.min(sampleRate, 96000))];
    if (!plan.stereoFallback && plan.sourceSampleRate > 0 && envFlag("LOUDNORM_GPU_ORIGINAL_SOURCE_SAMPLE_RATE")) return ["-ar", String(plan.sourceSampleRate)];
    if (!plan.stereoFallback && plan.sourceSampleRate > 0 && ffmpegLinearMode(values)) return ["-ar", String(plan.sourceSampleRate)];
    return [];
  };
  const decodeAudioArgs = (plan) => {
    if (needsInlineStereoDownmix(plan)) return ["-af", "aformat=channel_layouts=stereo"];
    if (canSkipOriginalAformat(plan)) return [];
    if (plan.channelLayout) return ["-af", `aformat=channel_layouts=${plan.channelLayout}`];
    return ["-ac", String(plan.channels)];
  };
  const rawInputAudioArgs = (plan, values) => [
    "-ac", String(plan.channels),
    ...(plan.channelLayout ? ["-channel_layout", plan.channelLayout] : []),
    "-ar", String(processingSampleRateFor(plan, values)),
  ];
  const chunkMiBFor = (plan) => (plan.stereoFallback && stereoFallbackChunkMiB ? stereoFallbackChunkMiB : defaultChunkMiB);
  const applyChunkMiBFor = (plan) => {
    if (plan.stereoFallback && stereoFallbackApplyChunkMiB) return stereoFallbackApplyChunkMiB;
    if (!plan.stereoFallback && originalApplyChunkMiB) return originalApplyChunkMiB;
    return chunkMiBFor(plan);
  };
  const cpuLoudnormProgressArgs = (background) => (background && envFlag("LOUDNORM_GPU_CPU_LOUDNORM_BACKGROUND_NO_PROGRESS", true) ? [] : ["-progress", "pipe:2"]);
  const maybeNiceCpuLoudnorm = (command) => (cpuLoudnormNice > 0 ? `nice -n ${cpuLoudnormNice} ${command}` : command);
  const buildCpuLoudnormMeasure = (plan, opts = {}) => maybeNiceCpuLoudnorm([
    q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", ...cpuLoudnormProgressArgs(opts.background === true), "-y", "-i", q(plan.sourceInput),
    "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn",
    "-af", q(cpuLoudnormFilter(plan)),
    "-f", "null", (args.platform === "win32" ? "NUL" : "/dev/null"),
  ].join(" "));
  const buildPairedCpuLoudnormMeasure = (plan, partner, opts = {}) => {
    const originalPlan = plan.stereoFallback ? partner : plan;
    const stereoPlan = plan.stereoFallback ? plan : partner;
    const filterGraph = `[0:a:${originalPlan.sourceAudioIdx}]asplit=2[orig_in][stereo_in];[orig_in]${loudnormFilter()}[orig_out];[stereo_in]aformat=channel_layouts=stereo,${loudnormFilter()}[stereo_out]`;
    return maybeNiceCpuLoudnorm([
      q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", ...cpuLoudnormProgressArgs(opts.background === true), "-y", "-i", q(originalPlan.sourceInput),
      "-filter_complex", q(filterGraph),
      "-map", "[orig_out]", "-f", "null", (args.platform === "win32" ? "NUL" : "/dev/null"),
      "-map", "[stereo_out]", "-f", "null", (args.platform === "win32" ? "NUL" : "/dev/null"),
    ].join(" "));
  };

  return {
    loudnormFilter,
    loudnessSummary,
    canSkipOriginalAformat,
    cpuLoudnormFilter,
    ffmpegLinearMode,
    processingSampleRateFor,
    encodeSampleRateArgsFor,
    decodeAudioArgs,
    rawInputAudioArgs,
    chunkMiBFor,
    applyChunkMiBFor,
    cpuLoudnormProgressArgs,
    buildCpuLoudnormMeasure,
    buildPairedCpuLoudnormMeasure,
  };
}

module.exports = {
  createAudioCommandHelpers,
};
