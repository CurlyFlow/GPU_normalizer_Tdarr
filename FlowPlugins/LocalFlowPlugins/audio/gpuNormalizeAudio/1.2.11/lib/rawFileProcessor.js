"use strict";

const fs = require("fs");

const {
  ffmpegProgressFraction,
  gpuProgressFraction,
  logProfileStage,
} = require("./common");
const {
  finishCompletedStream,
} = require("./streamCompletionTelemetry");

async function runRawFilePlan({
  args,
  debugLogging,
  plan,
  planLabel,
  describePlan,
  completedWork,
  measureSpan,
  decodeSpan,
  normalizeSpan,
  encodeSpan,
  streamStartedAt,
  durationSeconds,
  cpuLoudnormValues,
  useGpuSourcePort,
  targetI,
  maxGain,
  buildRawApplyCommand,
  buildRawDecodeCommand,
  buildRawEncodeCommand,
  buildRawSourcePortGpuPlan,
  buildSourceCoreGainsCommand,
  wrapRuntimeProfile,
  runShell,
  runChecked,
  skipNormalization,
  updateProgress,
}) {
  const decode = buildRawDecodeCommand(plan, cpuLoudnormValues);
  const decodeRes = await runChecked(decode, {
    label: `decode ${planLabel}`,
    parseLine: (line) => {
      const fraction = ffmpegProgressFraction(line, durationSeconds);
      if (fraction !== null) updateProgress(completedWork + measureSpan + decodeSpan * fraction);
    },
  });
  updateProgress(completedWork + measureSpan + decodeSpan, true);
  const decodedBytes = fs.statSync(plan.rawInput).size;
  if (debugLogging) args.jobLog(`GPU normalize ${planLabel}: raw_pcm_bytes=${decodedBytes} raw_pcm_mib=${(decodedBytes / (1024 * 1024)).toFixed(1)}`);
  logProfileStage(args, { scope: "plugin", name: "ffmpeg_decode", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: decodeRes.wallSec, raw_mib: decodedBytes / (1024 * 1024) });

  if (useGpuSourcePort) {
    const gpuPlan = buildRawSourcePortGpuPlan(plan, cpuLoudnormValues, plan.rawInput, plan.rawGpu);
    const gpuRes = await runShell(wrapRuntimeProfile(gpuPlan, plan, "source-port"), {
      args,
      label: `GPU normalize ${planLabel}`,
      allowedCodes: [0, 42],
      capturePath: plan.sourceErr,
      logOnSuccess: debugLogging,
      parseLine: (line) => {
        const fraction = gpuProgressFraction(line);
        if (fraction !== null) updateProgress(completedWork + measureSpan + decodeSpan + normalizeSpan * fraction);
      },
    });
    logProfileStage(args, { scope: "plugin", name: "gpu_source_port", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: gpuRes.wallSec });
    if (gpuRes.code === 42) {
      throw new Error(`GPU gain gate disagrees with the measured per-stream decision on ${planLabel}`);
    }
    if (gpuRes.code !== 0) throw new Error(`GPU normalize failed on ${planLabel}`);
  } else {
    args.jobLog(`GPU normalize raw-file legacy backend enabled for ${planLabel}: diagnostic fallback path.`);
    const source = buildSourceCoreGainsCommand(plan);
    const sourceRes = await runChecked(source, {
      label: `source-core gains ${planLabel}`,
      capturePath: plan.sourceErr,
      logOnSuccess: debugLogging,
    });
    logProfileStage(args, { scope: "plugin", name: "source_core_gains", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: sourceRes.wallSec });
    const inputMatch = sourceRes.output.match(/input_i=([-+0-9.]+)/);
    if (maxGain > 0) {
      if (!inputMatch) throw new Error("GPU normalize: missing input_i in source metrics");
      const gainNeeded = targetI - Number.parseFloat(inputMatch[1]);
      args.jobLog(`GPU Normalize Audio decision: ${planLabel} needs ${gainNeeded.toFixed(2)} LU gain; limit is ${maxGain.toFixed(2)} LU.`);
      if (gainNeeded > maxGain) {
        await skipNormalization(plan, `gain limit exceeded on ${planLabel}`);
        return { completed: true };
      }
    }
    const apply = buildRawApplyCommand(plan);
    updateProgress(completedWork + decodeSpan + normalizeSpan * 0.65, true);
    const applyRes = await runChecked(apply, { label: `GPU apply ${planLabel}`, logOnSuccess: debugLogging });
    logProfileStage(args, { scope: "plugin", name: "gpu_apply", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: applyRes.wallSec });
  }
  updateProgress(completedWork + measureSpan + decodeSpan + normalizeSpan, true);

  const encode = buildRawEncodeCommand(plan, cpuLoudnormValues);
  const encodeRes = await runChecked(encode, {
    label: `encode ${planLabel}`,
    parseLine: (line) => {
      const fraction = ffmpegProgressFraction(line, durationSeconds);
      if (fraction !== null) updateProgress(completedWork + measureSpan + decodeSpan + normalizeSpan + encodeSpan * fraction);
    },
  });
  logProfileStage(args, { scope: "plugin", name: "ffmpeg_encode", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, raw_format: plan.rawGpuFormat, wall_sec: encodeRes.wallSec });
  await finishCompletedStream({
    args,
    plan,
    planLabel,
    describePlan,
    streamStartedAt,
    cleanupFiles: [plan.rawInput, plan.gains, plan.measureErr, plan.sourceErr, plan.rawGpu],
    runChecked,
  });
  return { completed: true };
}

module.exports = {
  runRawFilePlan,
};
