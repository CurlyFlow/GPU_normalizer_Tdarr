"use strict";

const fs = require("fs");

const {
  ffmpegProgressFraction,
  logProfileStage,
} = require("./common");
const {
  finishCompletedStream,
} = require("./streamCompletionTelemetry");
const {
  runRawNormalizeStep,
} = require("./rawFileNormalizeStep");

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
  copyOriginalPackage,
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

  const normalizeResult = await runRawNormalizeStep({
    args,
    debugLogging,
    plan,
    planLabel,
    completedWork,
    measureSpan,
    decodeSpan,
    normalizeSpan,
    cpuLoudnormValues,
    useGpuSourcePort,
    targetI,
    maxGain,
    buildRawApplyCommand,
    buildRawSourcePortGpuPlan,
    buildSourceCoreGainsCommand,
    wrapRuntimeProfile,
    runShell,
    runChecked,
    copyOriginalPackage,
    updateProgress,
  });
  if (normalizeResult.outputResult) return normalizeResult;
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
