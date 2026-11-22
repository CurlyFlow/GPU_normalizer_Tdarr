"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { intNum } = require("./common");
const { renderShellCommand } = require("./commandRenderer");
const { AAC_MOVIE_TIMESCALE, privateAacMovieArgs } = require("./outputAudioSpecs");
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
  rawInputAudioArgs,
  streamingRawInputAudioArgs,
  streamingRawOutputFormatFor,
  usesGpuSwrUpsample48k,
}) {
  const stereoFallbackStreamingFilterThreads = Math.max(0, Math.min(64, intNum(process.env.LOUDNORM_GPU_STEREO_FALLBACK_STREAMING_FILTER_THREADS, 0)));
  const stereoFallbackFilterThreadArgs = (plan) => (plan.stereoFallback && stereoFallbackStreamingFilterThreads > 0
    ? ["-filter_threads", String(stereoFallbackStreamingFilterThreads), "-filter_complex_threads", String(stereoFallbackStreamingFilterThreads)]
    : []);

  const buildStreamingDecodeCommand = (plan, values) => {
    const gpuUpsample48k = Boolean(usesGpuSwrUpsample48k && usesGpuSwrUpsample48k(plan, values));
    return [
      String(args.ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", ...stereoFallbackFilterThreadArgs(plan), "-i", String(plan.sourceInput),
      "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...decodeAudioArgs(plan),
      "-ar", String(gpuUpsample48k ? 48000 : ingressSampleRateFor(plan, values)),
      "-f", gpuUpsample48k ? "f32le" : plan.rawInputFormat, "pipe:1",
    ];
  };

  const outputFormatFor = streamingRawOutputFormatFor || ((plan) => plan.rawGpuFormat);
  const inputAudioArgsFor = streamingRawInputAudioArgs || rawInputAudioArgs;
  const aacEncodeMtBin = typeof __dirname === "string"
    ? path.resolve(__dirname, "../runtime/bin/aac_encode_mt")
    : "";
  const aacEncodeMtAvailable = Boolean(aacEncodeMtBin)
    && process.env.LOUDNORM_GPU_AAC_ENCODE_MT !== "0"
    && fs.existsSync(aacEncodeMtBin);
  const aacEncodeMtThreadsOverride = intNum(process.env.LOUDNORM_GPU_AAC_ENCODE_MT_THREADS, 0);
  const aacEncodeMtSupportedRates = new Set([96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000]);
  const aacEncodeMtSupportedLayouts = new Set(["", "stereo", "3.0", "4.0", "5.0", "5.0(side)", "5.1", "5.1(side)", "7.1", "7.1(wide)"]);
  const buildStreamingEncodeCommand = (plan, values) => {
    const rawFmt = outputFormatFor(plan, values);
    const inArgs = inputAudioArgsFor(plan, values);
    const outRateArgs = encodeSampleRateArgsFor(plan, values);
    if (aacEncodeMtAvailable && (rawFmt === "f32le" || rawFmt === "f64le")
        && /\.(?:m4a|mp4)$/i.test(String(plan.normalizedAudio || ""))
        && plan.channels >= 2 && plan.channels <= 16) {
      const arIdx = inArgs.indexOf("-ar");
      const acIdx = inArgs.indexOf("-ac");
      const clIdx = inArgs.indexOf("-channel_layout");
      const inRate = arIdx >= 0 ? Number(inArgs[arIdx + 1]) : 0;
      const inCh = acIdx >= 0 ? Number(inArgs[acIdx + 1]) : 0;
      const inLayout = clIdx >= 0 ? String(inArgs[clIdx + 1] || "") : "";
      const rawOutRate = outRateArgs[0] === "-ar" && outRateArgs[1] ? Number(outRateArgs[1]) : inRate;
      const outRate = rawOutRate > 96000 ? 96000 : rawOutRate;
      if (inRate > 0 && aacEncodeMtSupportedRates.has(outRate)
          && inCh >= 2 && inCh <= 16 && aacEncodeMtSupportedLayouts.has(inLayout)) {
        const defaultThreads = inCh === 6 ? 5 : Math.min(inCh, 6);
        const threads = aacEncodeMtThreadsOverride > 0
          ? Math.min(aacEncodeMtThreadsOverride, inCh)
          : defaultThreads;
        return [
          aacEncodeMtBin, "-f", rawFmt, "-ar", String(inRate), "-out_ar", String(outRate),
          "-ac", String(inCh), ...(inLayout ? ["-channel_layout", inLayout] : []),
          "-b", String(audioBitrate),
          "-movie_timescale", String(AAC_MOVIE_TIMESCALE),
          "-threads", String(threads), "-i", "pipe:0", "-o", String(plan.normalizedAudio),
        ];
      }
    }
    return [
      String(args.ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", ...stereoFallbackFilterThreadArgs(plan), "-f", rawFmt, ...inArgs,
      "-i", "pipe:0", ...outRateArgs, ...encodeThreadArgs(plan), "-c:a", "aac", "-b:a", audioBitrate, ...privateAacMovieArgs(plan.normalizedAudio), plan.normalizedAudio,
    ];
  };

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
    streamingRawInputAudioArgs, streamingRawOutputFormatFor, usesGpuSwrUpsample48k,
    encodeSampleRateArgsFor, applyChunkMiBFor,
  } = runtimeContext;
  const streamingBuilders = createStreamingCommandBuilders({
    args,
    audioBitrate,
    decodeAudioArgs,
    encodeSampleRateArgsFor,
    encodeThreadArgs,
    ingressSampleRateFor,
    rawInputAudioArgs,
    streamingRawInputAudioArgs,
    streamingRawOutputFormatFor,
    usesGpuSwrUpsample48k,
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
