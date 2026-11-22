"use strict";

const {
  renderShellCommand,
} = require("./commandRenderer");
const {
  defaultMeasuredLoudnormArgs,
  loudnormTargetArgs,
  measuredLoudnormArgs,
  pairedApplyMeasuredArgs,
  rawFormatArgs,
} = require("./runtimePlanArgs");
const {
  createRuntimePlanSpecPolicy,
} = require("./runtimePlanSpecPolicy");

function createRuntimePlanBuilders({
  gpuPlanCoreCommand,
  ffmpegPath,
  decodeAudioArgs,
  ingressSampleRateFor,
  processingSampleRateFor,
  usesGpuSwrDownsample96k = null,
  usesGpuSwrUpsample48k = null,
  targetI,
  targetLra,
  targetTp,
  maxGain,
  chunkMiBFor,
  applyChunkMiBFor,
  runtimeCuda,
  durationSeconds,
  usesStereoFallbackSourcePath,
}) {
  const runtimeSpecPolicy = createRuntimePlanSpecPolicy({
    decodeAudioArgs,
    ingressSampleRateFor,
    processingSampleRateFor,
    runtimeCuda,
    usesStereoFallbackSourcePath,
  });
  const firstPassOutputApplyChunkMiB = String(process.env.LOUDNORM_GPU_FIRST_PASS_OUTPUT_APPLY_CHUNK_MIB || "").trim();

  const buildGpuFirstPassMeasureArgv = (plan, statsSampleRate, statsCache, writeStatsCache, decodeCommandOverride = null, statsCacheInput = "") => {
    const decodeCommand = decodeCommandOverride || [
      String(ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", String(plan.sourceInput),
      "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...runtimeSpecPolicy.firstPassDecodeAudioArgs(plan), "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, "pipe:1",
    ];
    const encodeCommand = runtimeSpecPolicy.firstPassNullOutputWrite
      ? ["__loudnorm_null_write__"]
      : ["sh", "-lc", "cat >/dev/null"];
    const ratePlan = runtimeSpecPolicy.ratePlanFor(plan, null);
    return [
      ...gpuPlanCoreCommand(), "-", "-",
      "--rate", String(statsSampleRate), "--channels", String(plan.channels),
      ...loudnormTargetArgs({ targetI, targetLra, targetTp, maxGain, chunkMiB: firstPassOutputApplyChunkMiB || applyChunkMiBFor(plan) }),
      ...defaultMeasuredLoudnormArgs(),
      ...rawFormatArgs(plan),
      ...runtimeSpecPolicy.sourcePortArgsFor({ ratePlan, streamingIo: true, parallelFinalApply: true, expectedSeconds: durationSeconds, useIngress: false }),
      "--decode-command-json", JSON.stringify(decodeCommand),
      "--encode-command-json", JSON.stringify(encodeCommand),
      "--emit-first-pass-json",
      ...(statsCacheInput ? ["--stats-cache-input", statsCacheInput] : []),
      ...(writeStatsCache ? ["--stats-cache-output", statsCache] : []),
      ...(ratePlan.stereoFallbackSourceExact ? ["--stereo-fallback-source-exact"] : []),
    ];
  };

  const buildGpuFirstPassMeasure = (plan, statsSampleRate, statsCache, writeStatsCache) => renderShellCommand(
    buildGpuFirstPassMeasureArgv(plan, statsSampleRate, statsCache, writeStatsCache),
  );

  const buildGpuFirstPassInputMeasureArgv = (plan, statsSampleRate, statsCache, writeStatsCache, decodeCommandOverride = null) => {
    const useSwr48k = Boolean(usesGpuSwrUpsample48k && usesGpuSwrUpsample48k(plan, statsSampleRate) && !decodeCommandOverride);
    const decodeCommand = decodeCommandOverride || [
      String(ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", String(plan.sourceInput),
      "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...runtimeSpecPolicy.firstPassDecodeAudioArgs(plan),
      "-ar", String(useSwr48k ? 48000 : statsSampleRate),
      "-f", useSwr48k ? "f32le" : plan.rawInputFormat, "pipe:1",
    ];
    const ratePlan = runtimeSpecPolicy.ratePlanFor(plan, null);
    return [
      ...gpuPlanCoreCommand(), "-", "-",
      "--rate", String(statsSampleRate), "--channels", String(plan.channels),
      ...loudnormTargetArgs({ targetI, targetLra, targetTp, maxGain, chunkMiB: chunkMiBFor(plan) }),
      ...rawFormatArgs(plan),
      ...runtimeSpecPolicy.sourcePortArgsFor({ ratePlan, streamingIo: true, expectedSeconds: durationSeconds, useIngress: false }),
      "--decode-command-json", JSON.stringify(decodeCommand),
      "--ffmpeg-limiter", "--stats-cache-only", "--emit-first-pass-input-json",
      ...(writeStatsCache ? ["--stats-cache-output", statsCache] : []),
      ...(ratePlan.stereoFallbackSourceExact ? ["--stereo-fallback-source-exact"] : []),
      ...(useSwr48k ? ["--swr-upsample-48k-f32"] : []),
    ];
  };

  const buildGpuFirstPassInputMeasure = (plan, statsSampleRate, statsCache, writeStatsCache) => renderShellCommand(
    buildGpuFirstPassInputMeasureArgv(plan, statsSampleRate, statsCache, writeStatsCache),
  );

  const buildStatsRuntimePlanArgv = (plan, statsSampleRate, statsCache, statsDecodeCommand, extraArgs = []) => {
    const ratePlan = runtimeSpecPolicy.ratePlanFor(plan, null);
    return [
      ...gpuPlanCoreCommand(), "-", "-",
      "--rate", String(statsSampleRate), "--channels", String(plan.channels),
      ...loudnormTargetArgs({ targetI, targetLra, targetTp, maxGain, chunkMiB: chunkMiBFor(plan) }),
      ...rawFormatArgs(plan),
      ...runtimeSpecPolicy.sourcePortArgsFor({ ratePlan, streamingIo: true, expectedSeconds: durationSeconds, useIngress: false }),
      "--decode-command-json", JSON.stringify(statsDecodeCommand),
      "--ffmpeg-limiter", "--ffmpeg-gain-offset-ms", "210",
      "--stats-cache-output", statsCache, "--stats-cache-only",
      ...extraArgs,
      ...(ratePlan.stereoFallbackSourceExact ? ["--stereo-fallback-source-exact"] : []),
    ];
  };

  const buildStatsRuntimePlan = (plan, statsSampleRate, statsCache, statsDecodeCommand, extraArgs = []) => renderShellCommand(
    buildStatsRuntimePlanArgv(plan, statsSampleRate, statsCache, statsDecodeCommand, extraArgs),
  );

  const buildStreamingGpuPlanArgv = (plan, cpuLoudnormValues, decodeCommand, encodeCommand, statsCacheInput) => {
    const ratePlan = runtimeSpecPolicy.ratePlanFor(plan, cpuLoudnormValues);
    return [
      ...runtimeSpecPolicy.planEnvPrefix(plan),
      ...gpuPlanCoreCommand(), "-", "-",
      "--rate", String(ratePlan.processingRate), "--channels", String(plan.channels),
      ...loudnormTargetArgs({ targetI, targetLra, targetTp, maxGain, chunkMiB: applyChunkMiBFor(plan) }),
      ...measuredLoudnormArgs(cpuLoudnormValues),
      ...rawFormatArgs(plan),
      ...runtimeSpecPolicy.sourcePortArgsFor({ ratePlan, streamingIo: true, parallelFinalApply: true, expectedSeconds: durationSeconds }),
      "--decode-command-json", JSON.stringify(decodeCommand),
      "--encode-command-json", JSON.stringify(encodeCommand),
      ...(statsCacheInput ? ["--stats-cache-input", statsCacheInput] : []),
      ...(ratePlan.stereoFallbackSourceExact ? ["--stereo-fallback-source-exact"] : []),
      ...(usesGpuSwrDownsample96k && usesGpuSwrDownsample96k(plan, cpuLoudnormValues) ? ["--swr-downsample-96k-f32"] : []),
      ...(usesGpuSwrUpsample48k && usesGpuSwrUpsample48k(plan, cpuLoudnormValues) ? ["--swr-upsample-48k-f32"] : []),
    ];
  };

  const buildStreamingGpuPlan = (plan, cpuLoudnormValues, decodeCommand, encodeCommand, statsCacheInput) => renderShellCommand(
    buildStreamingGpuPlanArgv(plan, cpuLoudnormValues, decodeCommand, encodeCommand, statsCacheInput),
  );

  const buildRawSourcePortGpuPlanArgv = (plan, cpuLoudnormValues, inputPath, outputPath) => {
    const ratePlan = runtimeSpecPolicy.ratePlanFor(plan, cpuLoudnormValues);
    return [
      ...runtimeSpecPolicy.planEnvPrefix(plan),
      ...gpuPlanCoreCommand(), inputPath, outputPath,
      "--rate", String(ratePlan.processingRate), "--channels", String(plan.channels),
      ...loudnormTargetArgs({ targetI, targetLra, targetTp, maxGain, chunkMiB: applyChunkMiBFor(plan) }),
      ...measuredLoudnormArgs(cpuLoudnormValues),
      ...rawFormatArgs(plan),
      ...runtimeSpecPolicy.sourcePortArgsFor({ ratePlan, useIngress: false }),
      ...(ratePlan.stereoFallbackSourceExact ? ["--stereo-fallback-source-exact"] : []),
    ];
  };

  const buildRawSourcePortGpuPlan = (plan, cpuLoudnormValues, inputPath, outputPath) => renderShellCommand(
    buildRawSourcePortGpuPlanArgv(plan, cpuLoudnormValues, inputPath, outputPath),
  );

  const buildPairedStreamingGpuPlanArgv = (primaryPlan, primaryValues, primaryDecodeCommand, primaryEncodeCommand, primaryStatsCacheInput, partnerPlan, partnerValues, partnerDecodeCommand, partnerEncodeCommand, partnerStatsCacheInput) => {
    const partnerRatePlan = runtimeSpecPolicy.ratePlanFor(partnerPlan, partnerValues);
    return [
      ...buildStreamingGpuPlanArgv(primaryPlan, primaryValues, primaryDecodeCommand, primaryEncodeCommand, primaryStatsCacheInput),
      "--paired-apply-rate", String(partnerRatePlan.processingRate),
      "--paired-apply-channels", String(partnerPlan.channels),
      "--paired-apply-chunk-mib", String(applyChunkMiBFor(partnerPlan)),
      ...pairedApplyMeasuredArgs(partnerValues),
      "--paired-apply-decode-command-json", JSON.stringify(partnerDecodeCommand),
      "--paired-apply-encode-command-json", JSON.stringify(partnerEncodeCommand),
      "--paired-apply-stats-cache-input", partnerStatsCacheInput,
      ...(partnerRatePlan.stereoFallbackSourceExact ? ["--paired-apply-stereo-fallback-source-exact"] : []),
      ...(usesGpuSwrDownsample96k && usesGpuSwrDownsample96k(partnerPlan, partnerValues) ? ["--paired-apply-swr-downsample-96k-f32"] : []),
      ...(usesGpuSwrUpsample48k && usesGpuSwrUpsample48k(partnerPlan, partnerValues) ? ["--paired-apply-swr-upsample-48k-f32"] : []),
    ];
  };

  const renderPairedStreamingGpuPlan = (primaryPlan, primaryValues, primaryDecodeCommand, primaryEncodeCommand, primaryStatsCacheInput, partnerPlan, partnerValues, partnerDecodeCommand, partnerEncodeCommand, partnerStatsCacheInput) => renderShellCommand(
    buildPairedStreamingGpuPlanArgv(primaryPlan, primaryValues, primaryDecodeCommand, primaryEncodeCommand, primaryStatsCacheInput, partnerPlan, partnerValues, partnerDecodeCommand, partnerEncodeCommand, partnerStatsCacheInput),
  );

  return {
    buildGpuFirstPassMeasure,
    buildGpuFirstPassInputMeasure,
    buildRawSourcePortGpuPlan,
    buildStatsRuntimePlan,
    buildStreamingGpuPlan,
    buildPairedStreamingGpuPlan: renderPairedStreamingGpuPlan,
  };
}

module.exports = {
  createRuntimePlanBuilders,
};
