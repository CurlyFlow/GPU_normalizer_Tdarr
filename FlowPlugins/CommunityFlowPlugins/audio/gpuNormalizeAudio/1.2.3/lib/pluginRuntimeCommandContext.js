"use strict";

const {
  createPluginRuntimeFeatureConfig,
} = require("./pluginRuntimeFeatureConfig");
const {
  createPluginRuntimePlanContext,
} = require("./pluginRuntimePlanContext");
const {
  createRuntimeExecution,
} = require("./runtimeExecution");
const {
  createRuntimeExecutionInput,
  createRuntimeFeatureInput,
  createRuntimePlanInput,
} = require("./pluginRuntimeCommandModel");

function createPluginRuntimeCommandContext(context) {
  const {
    runChecked,
    wrapRuntimeProfile,
  } = createRuntimeExecution(createRuntimeExecutionInput(context));
  const {
    cpuLoudnormNice,
    gpuFirstPassAudit,
    gpuFirstPassMeasure,
    pairCpuLoudnormMeasure,
  } = createPluginRuntimeFeatureConfig(createRuntimeFeatureInput(context));
  const {
    loudnormFilter,
    loudnessSummary,
    canSkipOriginalAformat,
    processingSampleRateFor,
    encodeSampleRateArgsFor,
    decodeAudioArgs,
    rawInputAudioArgs,
    applyChunkMiBFor,
    buildCpuLoudnormMeasure,
    buildPairedCpuLoudnormMeasure,
    buildGpuFirstPassMeasure,
    buildRawSourcePortGpuPlan,
    buildStatsRuntimePlan,
    buildStreamingGpuPlan,
    buildPairedStreamingGpuPlan,
  } = createPluginRuntimePlanContext(createRuntimePlanInput(context, { cpuLoudnormNice }));

  return {
    applyChunkMiBFor,
    buildCpuLoudnormMeasure,
    buildGpuFirstPassMeasure,
    buildPairedCpuLoudnormMeasure,
    buildPairedStreamingGpuPlan,
    buildRawSourcePortGpuPlan,
    buildStatsRuntimePlan,
    buildStreamingGpuPlan,
    canSkipOriginalAformat,
    decodeAudioArgs,
    encodeSampleRateArgsFor,
    gpuFirstPassAudit,
    gpuFirstPassMeasure,
    loudnessSummary,
    loudnormFilter,
    pairCpuLoudnormMeasure,
    processingSampleRateFor,
    rawInputAudioArgs,
    runChecked,
    wrapRuntimeProfile,
  };
}

module.exports = {
  createPluginRuntimeCommandContext,
};
