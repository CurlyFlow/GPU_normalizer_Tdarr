"use strict";

const {
  envFlag,
} = require("./common");
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
  const originalRuntimeEnv = [
    ["LOUDNORM_GPU_ORIGINAL_SAFE_FEEDBACK_SLOT_ACCUM", "LOUDNORM_GPU_SAFE_FEEDBACK_SLOT_ACCUM"],
    ["LOUDNORM_GPU_ORIGINAL_PARALLEL_UNSAFE_FEEDBACK", "LOUDNORM_GPU_PARALLEL_UNSAFE_FEEDBACK"],
  ];
  const planEnvPrefix = (plan) => {
    if (plan.stereoFallback) return [];
    const envArgs = originalRuntimeEnv
      .map(([sourceName, targetName]) => [targetName, String(process.env[sourceName] || "").trim()])
      .filter(([, value]) => value !== "")
      .map(([targetName, value]) => `${targetName}=${value}`);
    return envArgs.length > 0 ? ["env", ...envArgs] : [];
  };
  const firstPassDecodeAudioArgs = (plan) => {
    if (envFlag("LOUDNORM_GPU_FIRST_PASS_CPU_DECODE_ARGS", true) && !plan.stereoFallback) return [];
    return decodeAudioArgs(plan);
  };
  const buildGpuFirstPassMeasureArgv = (plan, statsSampleRate, statsCache, writeStatsCache) => {
    const decodeCommand = [
      String(ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", String(plan.sourceInput),
      "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...firstPassDecodeAudioArgs(plan), "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, "pipe:1",
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

  const buildGpuFirstPassInputMeasureArgv = (plan, statsSampleRate, statsCache, writeStatsCache) => {
    const decodeCommand = [
      String(ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", String(plan.sourceInput),
      "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...firstPassDecodeAudioArgs(plan), "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, "pipe:1",
    ];
    return [
      ...gpuPlanCoreCommand(), "-", "-",
      "--rate", String(statsSampleRate), "--channels", String(plan.channels),
      ...loudnormTargetArgs({ targetI, targetLra, targetTp, maxGain, chunkMiB: chunkMiBFor(plan) }),
      ...rawFormatArgs(plan),
      ...sourcePortRuntimeArgs({ runtimeCuda, sourceCorePath, streamingIo: true, expectedSeconds: durationSeconds }),
      "--decode-command-json", JSON.stringify(decodeCommand),
      "--ffmpeg-limiter", "--stats-cache-only", "--emit-first-pass-input-json",
      ...(writeStatsCache ? ["--stats-cache-output", statsCache] : []),
      ...(usesStereoFallbackSourcePath(plan) ? ["--stereo-fallback-source-exact"] : []),
    ];
  };

  const buildGpuFirstPassInputMeasure = (plan, statsSampleRate, statsCache, writeStatsCache) => renderShellCommand(
    buildGpuFirstPassInputMeasureArgv(plan, statsSampleRate, statsCache, writeStatsCache),
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
    ...planEnvPrefix(plan),
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
    ...planEnvPrefix(plan),
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
