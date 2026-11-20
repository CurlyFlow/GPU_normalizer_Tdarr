"use strict";

const { rejectInput } = require("./inputRejection");
const { finalMuxMovieTimescale } = require("./movieTimescale");

const {
  createProgressUpdater,
  envFlag,
} = require("./common");
const {
  primaryAudioChannels,
} = require("./audioChannelHelpers");
const {
  buildAudioPlanContext,
} = require("./planContext");
const {
  buildFinalAudioSpecs,
} = require("./outputAudioSpecs");
const {
  buildFinalMuxCommand,
} = require("./outputMux");
const {
  createOutputStreamContract,
} = require("./outputValidation");

function createPluginPlanSetup({
  args,
  audioStreams,
  inputStreams,
  stereoLanguageOrder,
  normalizeOnlyLanguages,
  removeOtherLanguages,
  fallbackToUndetectedAudio = true,
  ensureStereo,
  stereoFallbackFirstOnly,
  sampleRate,
  durationSeconds,
  workDir,
  base,
  runId,
  gpuInputExt,
  gpuInputFormat,
  gpuOutputExt,
  gpuOutputFormat,
  tmpOutputFilePath,
  audioBitrate,
  debugLogging,
  container,
}) {
  const {
    audioPlanSet,
    audioPlans,
    describeRemove,
    fallbackUndetectedAudioPlans,
    removedAudioPlans,
    sourceAudioActions,
    skippedAudioPlans,
    inputAudioSummary,
    normalizeScopeText,
    stereoPlanText,
    describePlan,
    describeCopy,
    logDebugPlanSummary,
    statsCachePathFor,
    trackStatsPaths,
    audioWork,
    muxWork,
    totalWork,
    baselineEtaSeconds,
    cleanupFilesForPlan,
    cleanupAll,
    trackStatsCachePath,
  } = buildAudioPlanContext({
    args,
    audioStreams,
    container,
    stereoLanguageOrder,
    normalizeOnlyLanguages,
    removeOtherLanguages,
    fallbackToUndetectedAudio,
    ensureStereo,
    stereoFallbackFirstOnly,
    sampleRate,
    durationSeconds,
    workDir,
    base,
    runId,
    gpuInputExt,
    gpuInputFormat,
    gpuOutputExt,
    gpuOutputFormat,
    tmpOutputFilePath,
    debugLogging,
  });

  args.jobLog(`GPU Normalize Audio input audio: ${inputAudioSummary}`);
  args.jobLog(`GPU Normalize Audio settings: normalize ${normalizeScopeText}; remove other languages ${removeOtherLanguages ? "on" : "off"}; fallback to undetected audio ${fallbackToUndetectedAudio ? "on" : "off"}; ${stereoPlanText}; track order ${stereoLanguageOrder.join(", ") || "source order"}`);
  if (audioPlanSet.status.kind === "noAudioOutput") {
    logDebugPlanSummary();
    return { earlyResult: rejectInput(args, "noSelectedAudio", normalizeOnlyLanguages) };
  }
  if (audioPlanSet.status.kind === "passThrough") {
    args.jobLog(fallbackUndetectedAudioPlans.length > 0
      ? `GPU Normalize Audio plan: no audio stream matches ${normalizeOnlyLanguages.join(", ") || "the selected languages"}; keeping ${fallbackUndetectedAudioPlans.length} undetected audio stream(s) unchanged.`
      : `GPU Normalize Audio plan: no audio stream matches ${normalizeOnlyLanguages.join(", ") || "the selected languages"}; all audio will stay unchanged.`);
    logDebugPlanSummary();
    args.jobLog("GPU Normalize Audio result: no GPU work, no mux, file passed through unchanged.");
    if (typeof args.updateWorker === "function") args.updateWorker({ percentage: 100, ETA: "0:00:00" });
    return {
      earlyResult: { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables },
    };
  }
  if (audioPlanSet.status.kind === "muxOnly") {
    args.jobLog(`GPU Normalize Audio plan: no audio stream matches ${normalizeOnlyLanguages.join(", ")}; ${skippedAudioPlans.map(describeCopy).join("; ")}; removing ${removedAudioPlans.length} other audio stream(s).`);
  }
  if (audioPlanSet.status.kind === "normalize") {
    args.jobLog(`GPU Normalize Audio plan: ${audioPlans.map(describePlan).join("; ")}${skippedAudioPlans.length > 0 ? `; ${skippedAudioPlans.map(describeCopy).join("; ")}` : ""}${removedAudioPlans.length > 0 ? `; ${removedAudioPlans.map(describeRemove).join("; ")}` : ""}.`);
  }
  logDebugPlanSummary();
  const updateProgress = createProgressUpdater(args, totalWork, baselineEtaSeconds);
  const finalOutputFor = (gainSkipped) => {
    const audioSpecs = buildFinalAudioSpecs(audioPlanSet.muxInputs.final.normalize,
      audioPlanSet.muxInputs.final.copy, audioStreams, gainSkipped);
    return { audioSpecs, outputContract: createOutputStreamContract({ inputStreams, audioSpecs, container }),
      buildMux: () => buildFinalMuxCommand({ ffmpegPath: args.ffmpegPath, inputFile: args.inputFileObj._id,
        inputStreams, audioSpecs, container, audioBitrate, tmpOutputFilePath,
        movieTimescale: finalMuxMovieTimescale({ inputFile: args.inputFileObj._id, inputStreams, audioSpecs, outputFile: tmpOutputFilePath }) }) };
  };
  const finalOutput = finalOutputFor(new Set());

  const planLabelFor = (plan) => `audio stream ${plan.sourceIdx}${plan.stereoFallback ? " stereo fallback" : ""}`;
  const sourceChannelsFor = (plan) => primaryAudioChannels(audioStreams[plan.sourceIdx], plan.channels);
  const needsInlineStereoDownmix = (plan) => plan.channels === 2 && sourceChannelsFor(plan) !== 2;
  const stereoFallbackSourceExact = envFlag("LOUDNORM_GPU_STEREO_FALLBACK_SOURCE_EXACT", true);
  const usesStereoFallbackSourcePath = (plan) => stereoFallbackSourceExact && plan.stereoFallback && needsInlineStereoDownmix(plan);

  return {
    audioPlans,
    audioPlanSet,
    audioWork,
    cleanupAll,
    cleanupFilesForPlan,
    describePlan,
    earlyResult: null,
    fallbackUndetectedAudioPlans,
    finalOutputContract: finalOutput.outputContract,
    finalAudioSpecs: finalOutput.audioSpecs,
    finalOutputFor,
    logDebugPlanSummary,
    buildMux: finalOutput.buildMux,
    muxWork,
    needsInlineStereoDownmix,
    planLabelFor,
    skippedAudioPlans,
    removedAudioPlans,
    sourceAudioActions,
    sourceChannelsFor,
    statsCachePathFor,
    stereoFallbackSourceExact,
    totalWork,
    trackStatsCachePath,
    trackStatsPaths,
    updateProgress,
    usesStereoFallbackSourcePath,
  };
}

module.exports = {
  createPluginPlanSetup,
};
