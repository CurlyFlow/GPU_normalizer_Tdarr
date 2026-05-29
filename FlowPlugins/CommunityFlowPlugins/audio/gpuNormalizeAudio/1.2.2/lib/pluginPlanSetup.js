"use strict";

const {
  createProgressUpdater,
} = require("./common");
const {
  buildAudioPlanContext,
} = require("./planContext");
const {
  buildCopyOriginalCommand,
  buildFinalMuxCommand,
} = require("./outputMux");
const {
  createPluginPlanHelpers,
} = require("./pluginPlanHelpers");

function createPluginPlanSetup({
  args,
  audioStreams,
  stereoLanguageOrder,
  normalizeOnlyLanguages,
  removeOtherLanguages,
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
    audioPlans,
    copyOriginalAudioPlans,
    describeRemove,
    removedAudioPlans,
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
  } = buildAudioPlanContext({
    args,
    audioStreams,
    stereoLanguageOrder,
    normalizeOnlyLanguages,
    removeOtherLanguages,
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
  args.jobLog(`GPU Normalize Audio settings: normalize ${normalizeScopeText}; remove other languages ${removeOtherLanguages ? "on" : "off"}; ${stereoPlanText}; track order ${stereoLanguageOrder.join(", ") || "source order"}`);
  if (audioPlans.length === 0) {
    if (removedAudioPlans.length === 0) {
      args.jobLog(`GPU Normalize Audio plan: no audio stream matches ${normalizeOnlyLanguages.join(", ") || "the selected languages"}; all audio will stay unchanged.`);
      logDebugPlanSummary();
      args.jobLog("GPU Normalize Audio result: no GPU work, no mux, file passed through unchanged.");
      if (typeof args.updateWorker === "function") args.updateWorker({ percentage: 100, ETA: "0:00:00" });
      return {
        earlyResult: { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables },
      };
    }
    args.jobLog(`GPU Normalize Audio plan: no audio stream matches ${normalizeOnlyLanguages.join(", ")}; removing ${removedAudioPlans.length} other audio stream(s).`);
  }
  if (audioPlans.length > 0) {
    args.jobLog(`GPU Normalize Audio plan: ${audioPlans.map(describePlan).join("; ")}${skippedAudioPlans.length > 0 ? `; ${skippedAudioPlans.map(describeCopy).join("; ")}` : ""}${removedAudioPlans.length > 0 ? `; ${removedAudioPlans.map(describeRemove).join("; ")}` : ""}.`);
  }
  logDebugPlanSummary();
  const updateProgress = createProgressUpdater(args, totalWork, baselineEtaSeconds);
  const copyOriginal = buildCopyOriginalCommand({
    ffmpegPath: args.ffmpegPath,
    inputFile: args.inputFileObj._id,
    container,
    audioStreams,
    audioPlansToCopy: copyOriginalAudioPlans,
    audioBitrate,
    tmpOutputFilePath,
  });
  const mux = buildFinalMuxCommand({
    ffmpegPath: args.ffmpegPath,
    inputFile: args.inputFileObj._id,
    audioPlans,
    skippedAudioPlans,
    container,
    audioStreams,
    audioBitrate,
    tmpOutputFilePath,
  });

  const {
    needsInlineStereoDownmix,
    planLabelFor,
    sourceChannelsFor,
    stereoFallbackSourceExact,
    usesStereoFallbackSourcePath,
  } = createPluginPlanHelpers({ audioStreams });

  return {
    audioPlans,
    audioWork,
    cleanupAll,
    cleanupFilesForPlan,
    copyOriginal,
    describePlan,
    earlyResult: null,
    logDebugPlanSummary,
    mux,
    muxWork,
    needsInlineStereoDownmix,
    planLabelFor,
    skippedAudioPlans,
    removedAudioPlans,
    sourceChannelsFor,
    statsCachePathFor,
    stereoFallbackSourceExact,
    totalWork,
    trackStatsPaths,
    updateProgress,
    usesStereoFallbackSourcePath,
  };
}

module.exports = {
  createPluginPlanSetup,
};
