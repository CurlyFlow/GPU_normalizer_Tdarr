"use strict";

const {
  intNum,
  langTag,
  sampleBytes,
} = require("./common");
const {
  channelCount,
  sourceChannelLayout,
} = require("./audioChannelHelpers");

function buildAudioPlanPaths({
  workDir,
  base,
  suffix,
  runId,
  gpuInputExt,
  gpuInputFormat,
  gpuOutputExt,
  gpuOutputFormat,
}) {
  return {
    rawInput: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.input.${gpuInputExt}`,
    rawInputFormat: gpuInputFormat,
    gains: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.gains.f32`,
    statsCache: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.stats.bin`,
    measureErr: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.measure.err`,
    statsErr: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.stats.err`,
    sourceErr: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.source.err`,
    rawGpu: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.output.${gpuOutputExt}`,
    rawGpuFormat: gpuOutputFormat,
    normalizedAudio: `${workDir}/${base}.gpu-normalized.${suffix}.${runId}.m4a`,
    fifoInput: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.stream-in.fifo`,
    fifoOutput: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.stream-out.fifo`,
  };
}

function createSourceAudioPlans({
  args,
  audioStreams,
  workDir,
  base,
  runId,
  gpuInputExt,
  gpuInputFormat,
  gpuOutputExt,
  gpuOutputFormat,
}) {
  return audioStreams.map((stream, idx) => {
    const streamChannels = channelCount(args.inputs.channels, stream, 2);
    const suffix = `a${idx}`;
    return {
      idx,
      sourceIdx: idx,
      channels: streamChannels,
      channelLayout: sourceChannelLayout(stream, streamChannels),
      sourceSampleRate: intNum(stream.sample_rate, 0),
      language: langTag((stream.tags || {}).language || stream.language || "und"),
      stereoFallback: false,
      sourceInput: args.inputFileObj._id,
      sourceAudioIdx: idx,
      ...buildAudioPlanPaths({
        workDir,
        base,
        suffix,
        runId,
        gpuInputExt,
        gpuInputFormat,
        gpuOutputExt,
        gpuOutputFormat,
      }),
    };
  });
}

function createStereoFallbackPlan({
  args,
  audioStreams,
  sourceIdx,
  fallbackOrdinal,
  idx,
  workDir,
  base,
  runId,
  gpuInputExt,
  gpuInputFormat,
  gpuOutputExt,
  gpuOutputFormat,
}) {
  const stream = audioStreams[sourceIdx];
  const suffix = sourceIdx === 0 && fallbackOrdinal === 0 ? "stereo" : `stereo.a${sourceIdx}`;
  return {
    idx,
    sourceIdx,
    channels: 2,
    channelLayout: "stereo",
    sourceSampleRate: intNum(stream.sample_rate, 0),
    language: langTag((stream.tags || {}).language || stream.language || "und"),
    stereoFallback: true,
    sourceInput: args.inputFileObj._id,
    sourceAudioIdx: sourceIdx,
    ...buildAudioPlanPaths({
      workDir,
      base,
      suffix,
      runId,
      gpuInputExt,
      gpuInputFormat,
      gpuOutputExt,
      gpuOutputFormat,
    }),
  };
}

function createAudioRuntimePlans({
  audioPlans,
  sampleRate,
  durationSeconds,
  statsCachePathFor,
  statsErrPathFor,
}) {
  return audioPlans.map((plan) => {
    const statsCaches = [plan.statsCache];
    const statsErrs = [plan.statsErr];
    if (plan.sourceSampleRate > 0 && plan.sourceSampleRate !== sampleRate) {
      statsCaches.push(statsCachePathFor(plan, plan.sourceSampleRate));
      statsErrs.push(statsErrPathFor(plan, plan.sourceSampleRate));
    }
    return {
      ...plan,
      statsCaches,
      statsErrs,
      work: Math.max(1, durationSeconds * plan.channels),
      estimatedRawInputBytes: Math.ceil(durationSeconds * sampleRate * plan.channels * sampleBytes(plan.rawInputFormat)),
      estimatedRawOutputBytes: Math.ceil(durationSeconds * sampleRate * plan.channels * sampleBytes(plan.rawGpuFormat)),
    };
  });
}

module.exports = {
  createAudioRuntimePlans,
  createSourceAudioPlans,
  createStereoFallbackPlan,
};
