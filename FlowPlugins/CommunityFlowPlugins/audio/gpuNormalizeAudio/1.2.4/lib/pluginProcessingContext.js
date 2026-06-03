"use strict";

const {
  logPluginDebugSummary,
} = require("./pluginDebugLogging");
const {
  createPluginCommandBuilderContext,
} = require("./pluginCommandBuilderContext");
const {
  createPluginProcessingCoordinators,
} = require("./pluginProcessingCoordinators");

function createProcessingInput(model, runtimeContext, statsContext) {
  const { core, planSetup, preflight, runtimeConfig } = model;
  const { audioConfig, outputPathConfig, runtimePathConfig } = runtimeConfig;
  return {
    args: core.args,
    applyChunkMiBFor: runtimeContext.applyChunkMiBFor,
    audioBitrate: audioConfig.audioBitrate,
    audioPlans: planSetup.audioPlans,
    audioStreams: preflight.audioStreams,
    audioWork: planSetup.audioWork,
    buildRawSourcePortGpuPlan: runtimeContext.buildRawSourcePortGpuPlan,
    buildStreamingGpuPlan: runtimeContext.buildStreamingGpuPlan,
    buildPairedStreamingGpuPlan: runtimeContext.buildPairedStreamingGpuPlan,
    canFuseAnyCpuLoudnormWithSplitStats: statsContext.canFuseAnyCpuLoudnormWithSplitStats,
    canSkipOriginalAformat: runtimeContext.canSkipOriginalAformat,
    canSplitStatsPlan: statsContext.canSplitStatsPlan,
    cleanupAll: planSetup.cleanupAll,
    cleanupFilesForPlan: planSetup.cleanupFilesForPlan,
    container: outputPathConfig.container,
    copyOriginal: planSetup.copyOriginal,
    debugLogging: preflight.debugLogging,
    decodeAudioArgs: runtimeContext.decodeAudioArgs,
    describePlan: planSetup.describePlan,
    durationSeconds: outputPathConfig.durationSeconds,
    earlyCpuPrefetch: statsContext.earlyCpuPrefetch,
    earlyCpuPrefetchLimit: statsContext.earlyCpuPrefetchLimit,
    encodeSampleRateArgsFor: runtimeContext.encodeSampleRateArgsFor,
    encodeThreadArgs: audioConfig.encodeThreadArgs,
    getCpuLoudnormRecord: statsContext.getCpuLoudnormRecord,
    gpuApplyPath: runtimePathConfig.gpuApplyPath,
    gpuFirstPassMeasure: runtimeContext.gpuFirstPassMeasure,
    logDebugPlanSummary: planSetup.logDebugPlanSummary,
    maxGain: audioConfig.maxGain,
    mux: planSetup.mux,
    muxWork: planSetup.muxWork,
    needsInlineStereoDownmix: planSetup.needsInlineStereoDownmix,
    outputFilePath: outputPathConfig.outputFilePath,
    planLabelFor: planSetup.planLabelFor,
    pluginStartedAt: core.pluginStartedAt,
    prefetchCpuLoudnormFrom: statsContext.prefetchCpuLoudnormFrom,
    prefetchNextCpuLoudnorm: statsContext.prefetchNextCpuLoudnorm,
    prefetchNextSplitStats: statsContext.prefetchNextSplitStats,
    processingOrder: statsContext.processingOrder,
    processingPlans: statsContext.processingPlans,
    processingSampleRateFor: runtimeContext.processingSampleRateFor,
    pythonPath: runtimePathConfig.pythonPath,
    rawInputAudioArgs: runtimeContext.rawInputAudioArgs,
    removedAudioPlans: planSetup.removedAudioPlans,
    requireGpuWorker: preflight.requireGpuWorker,
    runChecked: runtimeContext.runChecked,
    runShell: core.runShell,
    sampleRate: audioConfig.sampleRate,
    skippedAudioPlans: planSetup.skippedAudioPlans,
    sourceCorePath: runtimePathConfig.sourceCorePath,
    splitPrefetchNextStatsAtProgress: statsContext.splitPrefetchNextStatsAtProgress,
    splitPrefetchNextStatsDuringStats: statsContext.splitPrefetchNextStatsDuringStats,
    startCpuLoudnormTask: statsContext.startCpuLoudnormTask,
    startSplitStatsTask: statsContext.startSplitStatsTask,
    stereoFallbackSourceExact: planSetup.stereoFallbackSourceExact,
    targetI: audioConfig.targetI,
    targetLra: audioConfig.targetLra,
    targetTp: audioConfig.targetTp,
    tmpOutputFilePath: outputPathConfig.tmpOutputFilePath,
    totalWork: planSetup.totalWork,
    updateProgress: planSetup.updateProgress,
    useGpuSourcePort: runtimePathConfig.useGpuSourcePort,
    usesStereoFallbackSourcePath: planSetup.usesStereoFallbackSourcePath,
    useStreamingSourcePort: audioConfig.useStreamingSourcePort,
    workerType: preflight.workerType,
    wrapRuntimeProfile: runtimeContext.wrapRuntimeProfile,
  };
}

function createPluginProcessingContext(model, runtimeContext, statsContext) {
  const context = createProcessingInput(model, runtimeContext, statsContext);
  const {
    args,
    audioPlans,
    debugLogging,
    logDebugPlanSummary,
    muxWork,
    planLabelFor,
    processingPlans,
    requireGpuWorker,
    stereoFallbackSourceExact,
    useGpuSourcePort,
    useStreamingSourcePort,
    workerType,
  } = context;
  const commandBuilders = createPluginCommandBuilderContext(context);
  const {
    finalizeOutput,
    isPairedDirectMuxCompleted,
    processStreams,
  } = createPluginProcessingCoordinators({
    ...context,
    ...commandBuilders,
  });

  logPluginDebugSummary({
    args,
    debugLogging,
    useGpuSourcePort,
    workerType,
    requireGpuWorker,
    logDebugPlanSummary,
    processingPlans,
    audioPlans,
    planLabelFor,
    stereoFallbackSourceExact,
    useStreamingSourcePort,
  });

  return {
    finalizeOutput,
    isPairedDirectMuxCompleted,
    muxWork,
    processStreams,
  };
}

module.exports = {
  createPluginProcessingContext,
};
