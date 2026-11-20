"use strict";

const { intNum } = require("./common");
const { renderShellCommand } = require("./commandRenderer");
const { privateAacMovieArgs } = require("./outputAudioSpecs");
const {
  createOutputFinalizer,
} = require("./outputFinalizer");
const {
  createPairedApplyCoordinator,
} = require("./pairedApplyCoordinator");
const {
  createStreamProcessor,
} = require("./streamProcessor");

function logPluginDebugSummary({
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
}) {
  if (!debugLogging) return;
  args.jobLog(useGpuSourcePort
    ? "Running GPU normalize: FFmpeg decode -> CUDA loudness/gain plan+apply -> FFmpeg encode/mux"
    : "Running GPU normalize: FFmpeg decode -> source-core exact gains -> CUDA apply -> FFmpeg encode/mux");
  args.jobLog(`GPU normalize Tdarr worker: worker_type=${workerType || "unknown"} require_gpu_worker=${requireGpuWorker ? "true" : "false"}`);
  logDebugPlanSummary();
  if (processingPlans !== audioPlans) args.jobLog(`GPU normalize processing order: ${processingPlans.map(planLabelFor).join(" -> ")}`);
  if (stereoFallbackSourceExact) args.jobLog("GPU normalize stereo fallback source-exact path enabled");
  for (const plan of audioPlans) {
    args.jobLog(`GPU normalize ${plan.sourceIdx}${plan.stereoFallback ? " stereo fallback" : ""}: estimated_raw_input_mib=${(plan.estimatedRawInputBytes / (1024 * 1024)).toFixed(1)} estimated_raw_output_mib=${(plan.estimatedRawOutputBytes / (1024 * 1024)).toFixed(1)} streaming_io=${useStreamingSourcePort ? "true" : "false"}`);
  }
}

function createStreamingCommandBuilders({
  args,
  audioBitrate,
  decodeAudioArgs,
  encodeSampleRateArgsFor,
  encodeThreadArgs,
  ingressSampleRateFor,
  processingSampleRateFor,
  rawInputAudioArgs,
}) {
  const stereoFallbackStreamingFilterThreads = Math.max(0, Math.min(64, intNum(process.env.LOUDNORM_GPU_STEREO_FALLBACK_STREAMING_FILTER_THREADS, 0)));
  const stereoFallbackFilterThreadArgs = (plan) => (plan.stereoFallback && stereoFallbackStreamingFilterThreads > 0
    ? ["-filter_threads", String(stereoFallbackStreamingFilterThreads), "-filter_complex_threads", String(stereoFallbackStreamingFilterThreads)]
    : []);

  const buildStreamingDecodeCommand = (plan, values) => [
    String(args.ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", ...stereoFallbackFilterThreadArgs(plan), "-i", String(plan.sourceInput),
    "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...decodeAudioArgs(plan), "-ar", String(ingressSampleRateFor(plan, values)), "-f", plan.rawInputFormat, "pipe:1",
  ];

  const buildStreamingEncodeCommand = (plan, values) => [
    String(args.ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", ...stereoFallbackFilterThreadArgs(plan), "-f", plan.rawGpuFormat, ...rawInputAudioArgs(plan, values),
    "-i", "pipe:0", ...encodeSampleRateArgsFor(plan, values), ...encodeThreadArgs(plan), "-c:a", "aac", "-b:a", audioBitrate, ...privateAacMovieArgs(plan.normalizedAudio), plan.normalizedAudio,
  ];

  return {
    buildStreamingDecodeCommand,
    buildStreamingEncodeCommand,
  };
}

function createCommandBuilders(model, runtimeContext) {
  const { args } = model.core;
  const { sourceCorePath, gpuApplyPath } = model.runtimeConfig.runtimePathConfig;
  const { sampleRate, targetI, targetLra, targetTp, audioBitrate, encodeThreadArgs } = model.runtimeConfig.audioConfig;
  const {
    decodeAudioArgs, ingressSampleRateFor, processingSampleRateFor, rawInputAudioArgs,
    encodeSampleRateArgsFor, applyChunkMiBFor,
  } = runtimeContext;
  const streamingBuilders = createStreamingCommandBuilders({
    args,
    audioBitrate,
    decodeAudioArgs,
    encodeSampleRateArgsFor,
    encodeThreadArgs,
    ingressSampleRateFor,
    processingSampleRateFor,
    rawInputAudioArgs,
  });

  const buildRawDecodeCommand = (plan, values) => renderShellCommand([
    args.ffmpegPath, "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", plan.sourceInput,
    "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...decodeAudioArgs(plan), "-ar", String(processingSampleRateFor(plan, values)), "-f", plan.rawInputFormat, plan.rawInput,
  ]);

  const buildSourceCoreGainsCommand = (plan) => renderShellCommand([
    sourceCorePath, "--stream", plan.rawInput, "/dev/null", String(sampleRate), String(plan.channels), plan.gains, String(targetI), String(targetLra), String(targetTp),
  ]);

  const buildRawApplyCommand = (plan) => renderShellCommand([
    gpuApplyPath, plan.rawInput, plan.gains, plan.rawGpu, "--chunk-mib", String(applyChunkMiBFor(plan)),
  ]);

  const buildRawEncodeCommand = (plan, values) => renderShellCommand([
    args.ffmpegPath, "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-f", plan.rawGpuFormat, ...rawInputAudioArgs(plan, values),
    "-i", plan.rawGpu, ...encodeSampleRateArgsFor(plan, values), ...encodeThreadArgs(plan), "-c:a", "aac", "-b:a", audioBitrate, ...privateAacMovieArgs(plan.normalizedAudio), plan.normalizedAudio,
  ]);

  return {
    buildRawApplyCommand,
    buildRawDecodeCommand,
    buildRawEncodeCommand,
    buildSourceCoreGainsCommand,
    ...streamingBuilders,
  };
}

function createStreamCommandInterface(model, runtimeContext, commandBuilders) {
  return {
    buildRawApplyCommand: commandBuilders.buildRawApplyCommand,
    buildRawDecodeCommand: commandBuilders.buildRawDecodeCommand,
    buildRawEncodeCommand: commandBuilders.buildRawEncodeCommand,
    buildRawSourcePortGpuPlan: runtimeContext.buildRawSourcePortGpuPlan,
    buildSourceCoreGainsCommand: commandBuilders.buildSourceCoreGainsCommand,
    buildStreamingDecodeCommand: commandBuilders.buildStreamingDecodeCommand,
    buildStreamingEncodeCommand: commandBuilders.buildStreamingEncodeCommand,
    buildStreamingGpuPlan: runtimeContext.buildStreamingGpuPlan,
    cleanupFilesForPlan: model.planSetup.cleanupFilesForPlan,
    processingSampleRateFor: runtimeContext.processingSampleRateFor,
    runChecked: runtimeContext.runChecked,
    runShell: model.core.runShell,
    wrapRuntimeProfile: runtimeContext.wrapRuntimeProfile,
  };
}

function createStreamPipelineInterfaces({ model, runtimeContext, statsContext, commandBuilders }, pairedContext, outputContext) {
  const { core, preflight, planSetup, runtimeConfig } = model;
  const { audioConfig, outputPathConfig, runtimePathConfig } = runtimeConfig;
  return {
    commands: createStreamCommandInterface(model, runtimeContext, commandBuilders),
    execution: {
      args: core.args,
      debugLogging: preflight.debugLogging,
      durationSeconds: outputPathConfig.durationSeconds,
      gpuFirstPassMeasure: runtimeContext.gpuFirstPassMeasure,
      gpuFirstPassOriginalOnly: runtimeContext.gpuFirstPassOriginalOnly,
      maxGain: audioConfig.maxGain,
      targetI: audioConfig.targetI,
      useGpuSourcePort: runtimePathConfig.useGpuSourcePort,
      useStreamingSourcePort: audioConfig.useStreamingSourcePort,
    },
    output: {
      skipNormalization: outputContext.skipNormalization,
    },
    pairedApply: {
      pairStereoFallbackApply: pairedContext.pairStereoFallbackApply,
      pairedApplyCompleted: pairedContext.pairedApplyCompleted,
      pairedFallbackApplyPartner: pairedContext.pairedFallbackApplyPartner,
      runPairedFallbackApply: pairedContext.runPairedFallbackApply,
    },
    plans: {
      audioWork: planSetup.audioWork,
      describePlan: planSetup.describePlan,
      planLabelFor: planSetup.planLabelFor,
      processingOrder: statsContext.processingOrder,
      processingPlans: statsContext.processingPlans,
    },
    prefetch: {
      earlyCpuPrefetch: statsContext.earlyCpuPrefetch,
      earlyCpuPrefetchLimit: statsContext.earlyCpuPrefetchLimit,
      prefetchCpuLoudnormFrom: statsContext.prefetchCpuLoudnormFrom,
    },
    progress: {
      updateProgress: planSetup.updateProgress,
    },
    stats: statsContext,
  };
}

function createPluginProcessingContext(model, runtimeContext, statsContext) {
  const { args } = model.core;
  const { audioPlans, logDebugPlanSummary, muxWork, planLabelFor, stereoFallbackSourceExact } = model.planSetup;
  const { debugLogging, requireGpuWorker, workerType } = model.preflight;
  const { useGpuSourcePort } = model.runtimeConfig.runtimePathConfig;
  const { useStreamingSourcePort } = model.runtimeConfig.audioConfig;
  const { processingPlans } = statsContext;
  const commandBuilders = createCommandBuilders(model, runtimeContext);
  const processingContext = { model, runtimeContext, statsContext, commandBuilders };
  const pairedContext = createPairedApplyCoordinator(processingContext);
  const outputContext = createOutputFinalizer(processingContext);
  const streamContext = createStreamProcessor(
    createStreamPipelineInterfaces(processingContext, pairedContext, outputContext),
  );

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
    finalizeOutput: outputContext.finalizeOutput,
    isPairedDirectMuxCompleted: pairedContext.isPairedDirectMuxCompleted,
    muxWork,
    processStreams: streamContext.processStreams,
  };
}

module.exports = {
  createPluginProcessingContext,
};
