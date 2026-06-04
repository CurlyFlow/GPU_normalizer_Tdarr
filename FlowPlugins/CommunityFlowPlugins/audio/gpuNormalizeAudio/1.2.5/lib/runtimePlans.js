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
  const buildGpuFirstPassMeasureArgv = (plan, statsSampleRate, statsCache, writeStatsCache) => {
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
      "--decode-command-json", JSON.stringify(decodeCommand),
      "--encode-command-json", JSON.stringify(encodeCommand),
      "--emit-first-pass-json",
      ...(writeStatsCache ? ["--stats-cache-output", statsCache] : []),
      ...(usesStereoFallbackSourcePath(plan) ? ["--stereo-fallback-source-exact"] : []),
    ];
  };

  const buildGpuFirstPassMeasure = (plan, statsSampleRate, statsCache, writeStatsCache) => renderShellCommand(
    buildGpuFirstPassMeasureArgv(plan, statsSampleRate, statsCache, writeStatsCache),
  );

  const buildStatsRuntimePlanArgv = (plan, statsSampleRate, statsCache, statsDecodeCommand, extraArgs = []) => [
    ...gpuPlanCoreCommand(), "-", "-",
    "--rate", String(statsSampleRate), "--channels", String(plan.channels),
    ...loudnormTargetArgs({ targetI, targetLra, targetTp, maxGain, chunkMiB: chunkMiBFor(plan) }),
    ...rawFormatArgs(plan),
    ...sourcePortRuntimeArgs({ runtimeCuda, sourceCorePath, streamingIo: true, expectedSeconds: durationSeconds }),
    "--decode-command-json", JSON.stringify(statsDecodeCommand),
    "--ffmpeg-limiter", "--ffmpeg-gain-offset-ms", "210",
    "--stats-cache-output", statsCache, "--stats-cache-only",
    ...extraArgs,
    ...(usesStereoFallbackSourcePath(plan) ? ["--stereo-fallback-source-exact"] : []),
  ];

  const buildStatsRuntimePlan = (plan, statsSampleRate, statsCache, statsDecodeCommand, extraArgs = []) => renderShellCommand(
    buildStatsRuntimePlanArgv(plan, statsSampleRate, statsCache, statsDecodeCommand, extraArgs),
  );

  const buildStreamingGpuPlanArgv = (plan, cpuLoudnormValues, decodeCommand, encodeCommand, statsCacheInput) => [
    ...gpuPlanCoreCommand(), "-", "-",
    "--rate", String(processingSampleRateFor(plan, cpuLoudnormValues)), "--channels", String(plan.channels),
    ...loudnormTargetArgs({ targetI, targetLra, targetTp, maxGain, chunkMiB: applyChunkMiBFor(plan) }),
    ...measuredLoudnormArgs(cpuLoudnormValues),
    ...rawFormatArgs(plan),
    ...sourcePortRuntimeArgs({ runtimeCuda, sourceCorePath, streamingIo: true, parallelFinalApply: true, expectedSeconds: durationSeconds }),
    "--decode-command-json", JSON.stringify(decodeCommand),
    "--encode-command-json", JSON.stringify(encodeCommand),
    ...(statsCacheInput ? ["--stats-cache-input", statsCacheInput] : []),
    ...(usesStereoFallbackSourcePath(plan) ? ["--stereo-fallback-source-exact"] : []),
  ];

  const buildStreamingGpuPlan = (plan, cpuLoudnormValues, decodeCommand, encodeCommand, statsCacheInput) => renderShellCommand(
    buildStreamingGpuPlanArgv(plan, cpuLoudnormValues, decodeCommand, encodeCommand, statsCacheInput),
  );

  const buildRawSourcePortGpuPlanArgv = (plan, cpuLoudnormValues, inputPath, outputPath) => [
    ...gpuPlanCoreCommand(), inputPath, outputPath,
    "--rate", String(processingSampleRateFor(plan, cpuLoudnormValues)), "--channels", String(plan.channels),
    ...loudnormTargetArgs({ targetI, targetLra, targetTp, maxGain, chunkMiB: applyChunkMiBFor(plan) }),
    ...measuredLoudnormArgs(cpuLoudnormValues),
    ...rawFormatArgs(plan),
    ...sourcePortRuntimeArgs({ runtimeCuda, sourceCorePath }),
    ...(usesStereoFallbackSourcePath(plan) ? ["--stereo-fallback-source-exact"] : []),
  ];

  const buildRawSourcePortGpuPlan = (plan, cpuLoudnormValues, inputPath, outputPath) => renderShellCommand(
    buildRawSourcePortGpuPlanArgv(plan, cpuLoudnormValues, inputPath, outputPath),
  );

  const buildPairedStreamingGpuPlanArgv = (primaryPlan, primaryValues, primaryDecodeCommand, primaryEncodeCommand, primaryStatsCacheInput, partnerPlan, partnerValues, partnerDecodeCommand, partnerEncodeCommand, partnerStatsCacheInput) => [
    ...buildStreamingGpuPlanArgv(primaryPlan, primaryValues, primaryDecodeCommand, primaryEncodeCommand, primaryStatsCacheInput),
    "--paired-apply-rate", String(processingSampleRateFor(partnerPlan, partnerValues)),
    "--paired-apply-channels", String(partnerPlan.channels),
    "--paired-apply-chunk-mib", String(applyChunkMiBFor(partnerPlan)),
    ...pairedApplyMeasuredArgs(partnerValues),
    "--paired-apply-decode-command-json", JSON.stringify(partnerDecodeCommand),
    "--paired-apply-encode-command-json", JSON.stringify(partnerEncodeCommand),
    "--paired-apply-stats-cache-input", partnerStatsCacheInput,
    ...(usesStereoFallbackSourcePath(partnerPlan) ? ["--paired-apply-stereo-fallback-source-exact"] : []),
  ];

  const renderPairedStreamingGpuPlan = (primaryPlan, primaryValues, primaryDecodeCommand, primaryEncodeCommand, primaryStatsCacheInput, partnerPlan, partnerValues, partnerDecodeCommand, partnerEncodeCommand, partnerStatsCacheInput) => renderShellCommand(
    buildPairedStreamingGpuPlanArgv(primaryPlan, primaryValues, primaryDecodeCommand, primaryEncodeCommand, primaryStatsCacheInput, partnerPlan, partnerValues, partnerDecodeCommand, partnerEncodeCommand, partnerStatsCacheInput),
  );

  return {
    buildGpuFirstPassMeasure,
    buildRawSourcePortGpuPlan,
    buildStatsRuntimePlan,
    buildStreamingGpuPlan,
    buildPairedStreamingGpuPlan: renderPairedStreamingGpuPlan,
  };
}

module.exports = {
  createRuntimePlanBuilders,
};
