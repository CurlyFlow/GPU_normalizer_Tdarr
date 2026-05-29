"use strict";

const {
  q,
} = require("./common");
const {
  defaultMeasuredLoudnormArgs,
  loudnormTargetArgs,
  measuredLoudnormArgs,
  pairedApplyMeasuredArgs,
  rawFormatArgs,
  sourcePortRuntimeArgs,
} = require("./runtimePlanArgs");

function createRuntimePlanBuilders({
  gpuPlanCoreCommand,
  ffmpegPath,
  decodeAudioArgs,
  processingSampleRateFor,
  targetI,
  targetLra,
  targetTp,
  maxGain,
  chunkMiBFor,
  applyChunkMiBFor,
  runtimeCuda,
  sourceCorePath,
  durationSeconds,
  usesStereoFallbackSourcePath,
}) {
  const buildGpuFirstPassMeasure = (plan, statsSampleRate, statsCache, writeStatsCache) => {
    const decodeCommand = [
      String(ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", String(plan.sourceInput),
      "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...decodeAudioArgs(plan), "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, "pipe:1",
    ];
    const encodeCommand = ["sh", "-lc", "cat >/dev/null"];
    return [
      ...gpuPlanCoreCommand(), "-", "-",
      "--rate", String(statsSampleRate), "--channels", String(plan.channels),
      ...loudnormTargetArgs({ targetI, targetLra, targetTp, maxGain, chunkMiB: applyChunkMiBFor(plan) }),
      ...defaultMeasuredLoudnormArgs(),
      ...rawFormatArgs(plan),
      ...sourcePortRuntimeArgs({ runtimeCuda, sourceCorePath, streamingIo: true, parallelFinalApply: true, expectedSeconds: durationSeconds }),
      "--decode-command-json", q(JSON.stringify(decodeCommand)),
      "--encode-command-json", q(JSON.stringify(encodeCommand)),
      "--emit-first-pass-json",
      ...(writeStatsCache ? ["--stats-cache-output", q(statsCache)] : []),
      ...(usesStereoFallbackSourcePath(plan) ? ["--stereo-fallback-source-exact"] : []),
    ].join(" ");
  };

  const buildStatsRuntimePlan = (plan, statsSampleRate, statsCache, statsDecodeCommand, extraArgs = []) => [
    ...gpuPlanCoreCommand(), "-", "-",
    "--rate", String(statsSampleRate), "--channels", String(plan.channels),
    ...loudnormTargetArgs({ targetI, targetLra, targetTp, maxGain, chunkMiB: chunkMiBFor(plan) }),
    ...rawFormatArgs(plan),
    ...sourcePortRuntimeArgs({ runtimeCuda, sourceCorePath, streamingIo: true, expectedSeconds: durationSeconds }),
    "--decode-command-json", q(JSON.stringify(statsDecodeCommand)),
    "--ffmpeg-limiter", "--ffmpeg-gain-offset-ms", "210",
    "--stats-cache-output", q(statsCache), "--stats-cache-only",
    ...extraArgs,
    ...(usesStereoFallbackSourcePath(plan) ? ["--stereo-fallback-source-exact"] : []),
  ].join(" ");

  const buildStreamingGpuPlan = (plan, cpuLoudnormValues, decodeCommand, encodeCommand, statsCacheInput) => [
    ...gpuPlanCoreCommand(), "-", "-",
    "--rate", String(processingSampleRateFor(plan, cpuLoudnormValues)), "--channels", String(plan.channels),
    ...loudnormTargetArgs({ targetI, targetLra, targetTp, maxGain, chunkMiB: applyChunkMiBFor(plan) }),
    ...measuredLoudnormArgs(cpuLoudnormValues),
    ...rawFormatArgs(plan),
    ...sourcePortRuntimeArgs({ runtimeCuda, sourceCorePath, streamingIo: true, parallelFinalApply: true, expectedSeconds: durationSeconds }),
    "--decode-command-json", q(JSON.stringify(decodeCommand)),
    "--encode-command-json", q(JSON.stringify(encodeCommand)),
    ...(statsCacheInput ? ["--stats-cache-input", q(statsCacheInput)] : []),
    ...(usesStereoFallbackSourcePath(plan) ? ["--stereo-fallback-source-exact"] : []),
  ].join(" ");

  const buildRawSourcePortGpuPlan = (plan, cpuLoudnormValues, inputPath, outputPath) => [
    ...gpuPlanCoreCommand(), q(inputPath), q(outputPath),
    "--rate", String(processingSampleRateFor(plan, cpuLoudnormValues)), "--channels", String(plan.channels),
    ...loudnormTargetArgs({ targetI, targetLra, targetTp, maxGain, chunkMiB: applyChunkMiBFor(plan) }),
    ...measuredLoudnormArgs(cpuLoudnormValues),
    ...rawFormatArgs(plan),
    ...sourcePortRuntimeArgs({ runtimeCuda, sourceCorePath }),
    ...(usesStereoFallbackSourcePath(plan) ? ["--stereo-fallback-source-exact"] : []),
  ].join(" ");

  const buildPairedStreamingGpuPlan = (primaryPlan, primaryValues, primaryDecodeCommand, primaryEncodeCommand, primaryStatsCacheInput, partnerPlan, partnerValues, partnerDecodeCommand, partnerEncodeCommand, partnerStatsCacheInput) => [
    buildStreamingGpuPlan(primaryPlan, primaryValues, primaryDecodeCommand, primaryEncodeCommand, primaryStatsCacheInput),
    "--paired-apply-rate", String(processingSampleRateFor(partnerPlan, partnerValues)),
    "--paired-apply-channels", String(partnerPlan.channels),
    "--paired-apply-chunk-mib", q(applyChunkMiBFor(partnerPlan)),
    ...pairedApplyMeasuredArgs(partnerValues),
    "--paired-apply-decode-command-json", q(JSON.stringify(partnerDecodeCommand)),
    "--paired-apply-encode-command-json", q(JSON.stringify(partnerEncodeCommand)),
    "--paired-apply-stats-cache-input", q(partnerStatsCacheInput),
    ...(usesStereoFallbackSourcePath(partnerPlan) ? ["--paired-apply-stereo-fallback-source-exact"] : []),
  ].join(" ");

  return {
    buildGpuFirstPassMeasure,
    buildRawSourcePortGpuPlan,
    buildStatsRuntimePlan,
    buildStreamingGpuPlan,
    buildPairedStreamingGpuPlan,
  };
}

module.exports = {
  createRuntimePlanBuilders,
};
