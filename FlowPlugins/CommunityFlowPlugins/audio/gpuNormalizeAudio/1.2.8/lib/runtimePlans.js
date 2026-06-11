"use strict";

const {
  envFlag,
  q,
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
  ingressSampleRateFor,
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
    ["LOUDNORM_GPU_ORIGINAL_GROWABLE_ZERO_COPY_ENCODE_WRITE", "LOUDNORM_GPU_GROWABLE_ZERO_COPY_ENCODE_WRITE"],
    ["LOUDNORM_GPU_ORIGINAL_EXACT_APPLY_ASYNC_OUTPUT", "LOUDNORM_GPU_EXACT_APPLY_ASYNC_OUTPUT"],
    ["LOUDNORM_GPU_ORIGINAL_EXACT_APPLY_ASYNC_OUTPUT_DIRECT", "LOUDNORM_GPU_EXACT_APPLY_ASYNC_OUTPUT_DIRECT"],
    ["LOUDNORM_GPU_ORIGINAL_EXACT_APPLY_ASYNC_OUTPUT_DOUBLE_BUFFER", "LOUDNORM_GPU_EXACT_APPLY_ASYNC_OUTPUT_DOUBLE_BUFFER"],
    ["LOUDNORM_GPU_ORIGINAL_EXACT_OUTPUT_PINNED_WRITER", "LOUDNORM_GPU_EXACT_OUTPUT_PINNED_WRITER"],
    ["LOUDNORM_GPU_ORIGINAL_EXACT_OUTPUT_PINNED_WRITER_SLOTS", "LOUDNORM_GPU_EXACT_OUTPUT_PINNED_WRITER_SLOTS"],
    ["LOUDNORM_GPU_ORIGINAL_EXACT_OUTPUT_EVENT_WRITER", "LOUDNORM_GPU_EXACT_OUTPUT_EVENT_WRITER"],
    ["LOUDNORM_GPU_ORIGINAL_EXACT_OUTPUT_EVENT_WRITER_SLOTS", "LOUDNORM_GPU_EXACT_OUTPUT_EVENT_WRITER_SLOTS"],
    ["LOUDNORM_GPU_ORIGINAL_SYNC_OUTPUT_PINNED_BORROWED", "LOUDNORM_GPU_SYNC_OUTPUT_PINNED_BORROWED"],
    ["LOUDNORM_GPU_ORIGINAL_SYNC_OUTPUT_PINNED_BORROWED_SLOTS", "LOUDNORM_GPU_SYNC_OUTPUT_PINNED_BORROWED_SLOTS"],
    ["LOUDNORM_GPU_ORIGINAL_ENCODE_PIPE_F32", "LOUDNORM_GPU_ENCODE_PIPE_F32"],
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
    if (envFlag("LOUDNORM_GPU_FIRST_PASS_CPU_DECODE_ARGS", false) && !plan.stereoFallback) return [];
    return decodeAudioArgs(plan);
  };
  const buildFirstPassDecodeCommand = (plan, statsSampleRate, output = "pipe:1") => [
    String(ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", String(plan.sourceInput),
    "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...firstPassDecodeAudioArgs(plan), "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, output,
  ];
  const ingressRuntimeRateFor = (plan, values, runtimeRate) => {
    if (!ingressSampleRateFor) return 0;
    const ingressRate = ingressSampleRateFor(plan, values);
    return ingressRate > 0 && ingressRate !== runtimeRate ? ingressRate : 0;
  };
  const decodeAtRuntimeRateArgs = ({ runtimeCuda, sourceCorePath, streamingIo, parallelFinalApply = false, expectedSeconds }) => sourcePortRuntimeArgs({
    runtimeCuda,
    sourceCorePath,
    streamingIo,
    parallelFinalApply,
    expectedSeconds,
    ingressRate: 0,
  });

  const buildGpuFirstPassMeasureArgv = (plan, statsSampleRate, statsCache, writeStatsCache, decodeCommandOverride = null, statsCacheInput = "") => {
    const decodeCommand = decodeCommandOverride || [
      String(ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", String(plan.sourceInput),
      "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...firstPassDecodeAudioArgs(plan), "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, "pipe:1",
    ];
    const encodeCommand = envFlag("LOUDNORM_GPU_FIRST_PASS_NULL_OUTPUT_WRITE", true)
      ? ["__loudnorm_null_write__"]
      : ["sh", "-lc", "cat >/dev/null"];
    return [
      ...gpuPlanCoreCommand(), "-", "-",
      "--rate", String(statsSampleRate), "--channels", String(plan.channels),
      ...loudnormTargetArgs({ targetI, targetLra, targetTp, maxGain, chunkMiB: applyChunkMiBFor(plan) }),
      ...defaultMeasuredLoudnormArgs(),
      ...rawFormatArgs(plan),
      ...decodeAtRuntimeRateArgs({ runtimeCuda, sourceCorePath, streamingIo: true, parallelFinalApply: true, expectedSeconds: durationSeconds }),
      "--decode-command-json", JSON.stringify(decodeCommand),
      "--encode-command-json", JSON.stringify(encodeCommand),
      "--emit-first-pass-json",
      ...(statsCacheInput ? ["--stats-cache-input", statsCacheInput] : []),
      ...(writeStatsCache ? ["--stats-cache-output", statsCache] : []),
      ...(usesStereoFallbackSourcePath(plan) ? ["--stereo-fallback-source-exact"] : []),
    ];
  };

  const buildGpuFirstPassMeasure = (plan, statsSampleRate, statsCache, writeStatsCache) => renderShellCommand(
    buildGpuFirstPassMeasureArgv(plan, statsSampleRate, statsCache, writeStatsCache),
  );

  const buildGpuFirstPassInputMeasureArgv = (plan, statsSampleRate, statsCache, writeStatsCache, decodeCommandOverride = null) => {
    const decodeCommand = decodeCommandOverride || [
      String(ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", String(plan.sourceInput),
      "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...firstPassDecodeAudioArgs(plan), "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, "pipe:1",
    ];
    return [
      ...gpuPlanCoreCommand(), "-", "-",
      "--rate", String(statsSampleRate), "--channels", String(plan.channels),
      ...loudnormTargetArgs({ targetI, targetLra, targetTp, maxGain, chunkMiB: chunkMiBFor(plan) }),
      ...rawFormatArgs(plan),
      ...decodeAtRuntimeRateArgs({ runtimeCuda, sourceCorePath, streamingIo: true, expectedSeconds: durationSeconds }),
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
    ...decodeAtRuntimeRateArgs({ runtimeCuda, sourceCorePath, streamingIo: true, expectedSeconds: durationSeconds }),
    "--decode-command-json", JSON.stringify(statsDecodeCommand),
    "--ffmpeg-limiter", "--ffmpeg-gain-offset-ms", "210",
    "--stats-cache-output", statsCache, "--stats-cache-only",
    ...extraArgs,
    ...(usesStereoFallbackSourcePath(plan) ? ["--stereo-fallback-source-exact"] : []),
  ];

  const buildStatsRuntimePlan = (plan, statsSampleRate, statsCache, statsDecodeCommand, extraArgs = []) => renderShellCommand(
    buildStatsRuntimePlanArgv(plan, statsSampleRate, statsCache, statsDecodeCommand, extraArgs),
  );

  const buildGpuFirstPassOutputApplyFromStats = (plan, statsSampleRate, statsCacheInput) => renderShellCommand(
    buildGpuFirstPassMeasureArgv(plan, statsSampleRate, "", false, null, statsCacheInput),
  );

  const buildGpuFirstPassMixedSharedStats = (plan, processingSampleRate, sourceSampleRate, inputStatsCache, writeInputStatsCache, outputStatsCache) => {
    const inputFifo = `${plan.measureErr}.mixed-input.raw`;
    const outputStatsFifo = `${plan.measureErr}.mixed-output-stats.raw`;
    const inputCmd = renderShellCommand(buildGpuFirstPassInputMeasureArgv(
      plan,
      processingSampleRate,
      inputStatsCache,
      writeInputStatsCache,
      ["__loudnorm_open_fifo__", inputFifo],
    ));
    const outputStatsCmd = renderShellCommand(buildStatsRuntimePlanArgv(
      plan,
      sourceSampleRate,
      outputStatsCache,
      ["__loudnorm_open_fifo__", outputStatsFifo],
    ));
    const outputArgs = (label, rate, fifo) => [
      "-map", label, "-vn", "-sn", "-dn", ...firstPassDecodeAudioArgs(plan), "-ar", String(rate), "-f", plan.rawInputFormat, fifo,
    ];
    const ffmpegCmd = [
      String(ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", String(plan.sourceInput),
      "-filter_complex", `[0:a:${plan.sourceAudioIdx}]asplit=2[mixed_in][mixed_out]`,
      ...outputArgs("[mixed_in]", processingSampleRate, inputFifo),
      ...outputArgs("[mixed_out]", sourceSampleRate, outputStatsFifo),
    ].map(q).join(" ");
    return [
      "set -e",
      `input_fifo=${q(inputFifo)}`,
      `output_stats_fifo=${q(outputStatsFifo)}`,
      "rm -f \"$input_fifo\" \"$output_stats_fifo\"",
      "mkfifo \"$input_fifo\" \"$output_stats_fifo\"",
      "input_pid=",
      "out_stats_pid=",
      "ff_pid=",
      "cleanup() { rc=$?; for pid in \"$ff_pid\" \"$input_pid\" \"$out_stats_pid\"; do if [ -n \"$pid\" ]; then kill \"$pid\" 2>/dev/null || true; fi; done; rm -f \"$input_fifo\" \"$output_stats_fifo\"; exit $rc; }",
      "trap cleanup EXIT",
      `(${inputCmd}) & input_pid=$!`,
      `(${outputStatsCmd}) & out_stats_pid=$!`,
      `(${ffmpegCmd}) & ff_pid=$!`,
      "wait \"$ff_pid\"",
      "wait \"$input_pid\"",
      "wait \"$out_stats_pid\"",
    ].join("; ");
  };

  const buildGpuFirstPassMixedSharedDecode = (plan, processingSampleRate, sourceSampleRate, inputStatsCache, writeInputStatsCache) => {
    const inputFifo = `${plan.measureErr}.mixed-input.raw`;
    const outputFifo = `${plan.measureErr}.mixed-output.raw`;
    const inputLog = `${plan.measureErr}.mixed-input.log`;
    const outputLog = `${plan.measureErr}.mixed-output.log`;
    const inputCmd = renderShellCommand(buildGpuFirstPassInputMeasureArgv(
      plan,
      processingSampleRate,
      inputStatsCache,
      writeInputStatsCache,
      ["__loudnorm_open_fifo__", inputFifo],
    ));
    const outputCmd = renderShellCommand(buildGpuFirstPassMeasureArgv(
      plan,
      sourceSampleRate,
      "",
      false,
      ["__loudnorm_open_fifo__", outputFifo],
    ));
    const outputArgs = (label, rate, fifo) => [
      "-map", label, "-vn", "-sn", "-dn", ...firstPassDecodeAudioArgs(plan), "-ar", String(rate), "-f", plan.rawInputFormat, fifo,
    ];
    const ffmpegCmd = [
      String(ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", String(plan.sourceInput),
      "-filter_complex", `[0:a:${plan.sourceAudioIdx}]asplit=2[mixed_in][mixed_out]`,
      ...outputArgs("[mixed_in]", processingSampleRate, inputFifo),
      ...outputArgs("[mixed_out]", sourceSampleRate, outputFifo),
    ].map(q).join(" ");
    return [
      "set -e",
      `input_fifo=${q(inputFifo)}`,
      `output_fifo=${q(outputFifo)}`,
      `input_log=${q(inputLog)}`,
      `output_log=${q(outputLog)}`,
      "rm -f \"$input_fifo\" \"$output_fifo\" \"$input_log\" \"$output_log\"",
      "mkfifo \"$input_fifo\" \"$output_fifo\"",
      "input_pid=",
      "output_pid=",
      "ff_pid=",
      "cleanup() { rc=$?; for pid in \"$ff_pid\" \"$input_pid\" \"$output_pid\"; do if [ -n \"$pid\" ]; then kill \"$pid\" 2>/dev/null || true; fi; done; rm -f \"$input_fifo\" \"$output_fifo\"; exit $rc; }",
      "trap cleanup EXIT",
      `(${inputCmd}) >\"$input_log\" 2>&1 & input_pid=$!`,
      `(${outputCmd}) >\"$output_log\" 2>&1 & output_pid=$!`,
      `(${ffmpegCmd}) & ff_pid=$!`,
      "wait \"$ff_pid\"",
      "wait \"$input_pid\"",
      "wait \"$output_pid\"",
      "printf '\\n__GPU_FIRST_PASS_INPUT_JSON__\\n'",
      "cat \"$input_log\"",
      "printf '\\n__GPU_FIRST_PASS_OUTPUT_JSON__\\n'",
      "cat \"$output_log\"",
      "rm -f \"$input_log\" \"$output_log\"",
    ].join("; ");
  };

  const buildStreamingGpuPlanArgv = (plan, cpuLoudnormValues, decodeCommand, encodeCommand, statsCacheInput) => [
    ...planEnvPrefix(plan),
    ...gpuPlanCoreCommand(), "-", "-",
    "--rate", String(processingSampleRateFor(plan, cpuLoudnormValues)), "--channels", String(plan.channels),
    ...loudnormTargetArgs({ targetI, targetLra, targetTp, maxGain, chunkMiB: applyChunkMiBFor(plan) }),
    ...measuredLoudnormArgs(cpuLoudnormValues),
    ...rawFormatArgs(plan),
    ...sourcePortRuntimeArgs({ runtimeCuda, sourceCorePath, streamingIo: true, parallelFinalApply: true, expectedSeconds: durationSeconds, ingressRate: ingressRuntimeRateFor(plan, cpuLoudnormValues, processingSampleRateFor(plan, cpuLoudnormValues)) }),
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
    buildGpuFirstPassMixedSharedDecode,
    buildGpuFirstPassMixedSharedStats,
    buildGpuFirstPassOutputApplyFromStats,
    buildRawSourcePortGpuPlan,
    buildStatsRuntimePlan,
    buildStreamingGpuPlan,
    buildPairedStreamingGpuPlan: renderPairedStreamingGpuPlan,
  };
}

module.exports = {
  createRuntimePlanBuilders,
};
