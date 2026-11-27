"use strict";

const {
  loudnormNumber,
} = require("./common");

function loudnormTargetArgs({ targetI, targetLra, targetTp, maxGain, chunkMiB }) {
  return [
    "--target-i", String(targetI), "--target-lra", String(targetLra), "--target-tp", String(targetTp),
    "--max-gain-db", String(maxGain), "--chunk-mib", String(chunkMiB),
  ];
}

function defaultMeasuredLoudnormArgs() {
  return [
    "--measured-i", "0", "--measured-lra", "0", "--measured-tp", "99", "--measured-thresh", "-70",
    "--offset-db", "0", "--ffmpeg-linear", "--ffmpeg-limiter", "--ffmpeg-gain-offset-ms", "210",
  ];
}

function measuredLoudnormArgs(values) {
  return [
    "--measured-i", String(loudnormNumber(values, "input_i")),
    "--measured-lra", String(loudnormNumber(values, "input_lra")),
    "--measured-tp", String(loudnormNumber(values, "input_tp")),
    "--measured-thresh", String(loudnormNumber(values, "input_thresh")),
    "--offset-db", String(loudnormNumber(values, "target_offset")), "--ffmpeg-linear", "--ffmpeg-limiter", "--ffmpeg-gain-offset-ms", "210",
  ];
}

function pairedApplyMeasuredArgs(values) {
  return [
    "--paired-apply-measured-i", String(loudnormNumber(values, "input_i")),
    "--paired-apply-measured-lra", String(loudnormNumber(values, "input_lra")),
    "--paired-apply-measured-tp", String(loudnormNumber(values, "input_tp")),
    "--paired-apply-measured-thresh", String(loudnormNumber(values, "input_thresh")),
    "--paired-apply-offset-db", String(loudnormNumber(values, "target_offset")),
  ];
}

function rawFormatArgs(plan) {
  return [
    "--input-format", plan.rawInputFormat,
    "--output-format", plan.rawGpuFormat,
  ];
}

function sourcePortRuntimeArgs({ runtimeCuda, streamingIo = false, parallelFinalApply = false, expectedSeconds = null, ingressRate = 0 }) {
  return [
    "--ptx-path", `${runtimeCuda}/loudnorm_source_port_kernels.ptx`,
    ...(streamingIo ? ["--streaming-io"] : []),
    ...(parallelFinalApply ? ["--parallel-final-apply"] : []),
    ...(expectedSeconds !== null ? ["--expected-seconds", String(Math.max(1, expectedSeconds))] : []),
    ...(ingressRate > 0 ? ["--ingress-rate", String(ingressRate)] : []),
  ];
}

function createOriginalRuntimeEnvArgs() {
  return [
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
  ]
    .map(([sourceName, targetName]) => [targetName, String(process.env[sourceName] || "").trim()])
    .filter(([, value]) => value !== "")
    .map(([targetName, value]) => `${targetName}=${value}`);
}

module.exports = {
  createOriginalRuntimeEnvArgs,
  defaultMeasuredLoudnormArgs,
  loudnormTargetArgs,
  measuredLoudnormArgs,
  pairedApplyMeasuredArgs,
  rawFormatArgs,
  sourcePortRuntimeArgs,
};
