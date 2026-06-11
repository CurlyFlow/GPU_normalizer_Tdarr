"use strict";

const {
  runRawFilePlan,
} = require("./rawFileProcessor");
const {
  runStreamingSourcePortPlan,
} = require("./streamingSourcePortProcessor");

function createStreamingSourcePortBackend(streamCtx) {
  const { commands, execution, output, plans, progress } = streamCtx;
  return {
    name: "streamingSourcePort",
    run: async ({ planState, splitStatsForPlan, measurement }) => {
      const { completedWork, plan, planLabel, spans, streamStartedAt } = planState;
      return await runStreamingSourcePortPlan({
        args: execution.args,
        debugLogging: execution.debugLogging,
        plan,
        planLabel,
        describePlan: plans.describePlan,
        completedWork,
        measureSpan: spans.measure,
        decodeSpan: spans.decode,
        normalizeSpan: spans.normalize,
        encodeSpan: spans.encode,
        streamStartedAt,
        splitStatsForPlan,
        firstPassStatsCacheInput: measurement.firstPassStatsCacheInput,
        splitStatsCacheInput: measurement.splitStatsCacheInput,
        cpuLoudnormValues: measurement.cpuLoudnormValues,
        buildStreamingDecodeCommand: commands.buildStreamingDecodeCommand,
        buildStreamingEncodeCommand: commands.buildStreamingEncodeCommand,
        buildStreamingGpuPlan: commands.buildStreamingGpuPlan,
        wrapRuntimeProfile: commands.wrapRuntimeProfile,
        runShell: commands.runShell,
        runChecked: commands.runChecked,
        cleanupFilesForPlan: commands.cleanupFilesForPlan,
        copyOriginalPackage: output.copyOriginalPackage,
        updateProgress: progress.updateProgress,
      });
    },
  };
}

function createRawFileBackend(streamCtx) {
  const { commands, execution, output, plans, progress } = streamCtx;
  return {
    name: "rawFile",
    run: async ({ planState, measurement }) => {
      const { completedWork, plan, planLabel, spans, streamStartedAt } = planState;
      return await runRawFilePlan({
        args: execution.args,
        debugLogging: execution.debugLogging,
        plan,
        planLabel,
        describePlan: plans.describePlan,
        completedWork,
        measureSpan: spans.measure,
        decodeSpan: spans.decode,
        normalizeSpan: spans.normalize,
        encodeSpan: spans.encode,
        streamStartedAt,
        durationSeconds: execution.durationSeconds,
        cpuLoudnormValues: measurement.cpuLoudnormValues,
        useGpuSourcePort: execution.useGpuSourcePort,
        targetI: execution.targetI,
        maxGain: execution.maxGain,
        buildRawApplyCommand: commands.buildRawApplyCommand,
        buildRawDecodeCommand: commands.buildRawDecodeCommand,
        buildRawEncodeCommand: commands.buildRawEncodeCommand,
        buildRawSourcePortGpuPlan: commands.buildRawSourcePortGpuPlan,
        buildSourceCoreGainsCommand: commands.buildSourceCoreGainsCommand,
        wrapRuntimeProfile: commands.wrapRuntimeProfile,
        runShell: commands.runShell,
        runChecked: commands.runChecked,
        copyOriginalPackage: output.copyOriginalPackage,
        updateProgress: progress.updateProgress,
      });
    },
  };
}

function selectStreamApplyBackend(streamCtx) {
  return streamCtx.execution.useStreamingSourcePort
    ? createStreamingSourcePortBackend(streamCtx)
    : createRawFileBackend(streamCtx);
}

module.exports = {
  selectStreamApplyBackend,
};
