"use strict";

const {
  streamSummary,
} = require("./audioChannelHelpers");
const {
  sortAudioPlansByLanguage,
} = require("./audioLanguageOrder");
const {
  createAudioSelection,
} = require("./audioSelection");
const {
  createSourceAudioPlans,
  createStereoFallbackPlan,
} = require("./audioPlanConstruction");
const {
  createAudioPlanRuntimeContext,
} = require("./audioPlanRuntimeContext");

function buildAudioPlanContext({
  args,
  audioStreams,
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
  debugLogging,
}) {
  const allSourceAudioPlans = createSourceAudioPlans({
    args,
    audioStreams,
    workDir,
    base,
    runId,
    gpuInputExt,
    gpuInputFormat,
    gpuOutputExt,
    gpuOutputFormat,
  });
  const sortedSourceAudioPlans = sortAudioPlansByLanguage(allSourceAudioPlans, stereoLanguageOrder);
  const {
    audioPlans,
    copyOriginalAudioPlans,
    fallbackUndetectedAudioPlans,
    removedAudioPlans,
    selectedLanguageKeys,
    shouldRemoveOtherLanguages,
    skippedAudioPlans,
    sourceAudioActions,
  } = createAudioSelection({
    sourceAudioPlans: sortedSourceAudioPlans,
    normalizeOnlyLanguages,
    removeOtherLanguages,
    fallbackToUndetectedAudio,
    ensureStereo,
    stereoFallbackFirstOnly,
    createStereoFallbackPlan: ({ sourceIdx, fallbackOrdinal, idx }) => createStereoFallbackPlan({
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
    }),
  });
  const describePlan = (plan) => {
    const source = allSourceAudioPlans[plan.sourceIdx];
    const sourceText = source ? `#${source.sourceIdx} ${source.language} ${source.channels}ch` : `#${plan.sourceIdx}`;
    if (plan.stereoFallback) return `create normalized stereo from ${sourceText}`;
    return `normalize ${sourceText}`;
  };
  const describeCopy = (plan) => `copy #${plan.sourceIdx} ${plan.language} ${plan.channels}ch unchanged`;
  const describeRemove = (plan) => `remove #${plan.sourceIdx} ${plan.language} ${plan.channels}ch`;
  const logDebugPlanSummary = () => {
    if (!debugLogging) return;
    args.jobLog(`GPU normalize audio streams: normalize_scope=${normalizeOnlyLanguages.length > 0 ? "only_languages" : "all"} normalize_only_languages=${normalizeOnlyLanguages.join(",") || "all"} remove_other_languages=${shouldRemoveOtherLanguages ? "true" : "false"} fallback_to_undetected_audio=${fallbackToUndetectedAudio ? "true" : "false"} selected_languages=${selectedLanguageKeys.join(",") || (normalizeOnlyLanguages.length > 0 ? "none" : "all")} normalized_count=${audioPlans.length} copied_audio_count=${skippedAudioPlans.length} fallback_undetected_count=${fallbackUndetectedAudioPlans.length} removed_audio_count=${removedAudioPlans.length} channel_input=${String(args.inputs.channels || "auto")} effective_channels=${audioPlans.map((plan) => plan.channels).join(",") || "none"} ensure_stereo=${ensureStereo ? "true" : "false"} stereo_scope=${ensureStereo ? (stereoFallbackFirstOnly ? "first_language" : "all_non_stereo_audio") : "off"} stereo_language_order=${stereoLanguageOrder.join(",") || "source"}`);
    if (skippedAudioPlans.length > 0) args.jobLog(`GPU normalize copied original audio streams unchanged: ${skippedAudioPlans.map((plan) => `${plan.sourceIdx}:${plan.language}`).join(",")}`);
    if (fallbackUndetectedAudioPlans.length > 0) args.jobLog(`GPU normalize fallback to undetected audio streams: ${fallbackUndetectedAudioPlans.map((plan) => `${plan.sourceIdx}:${plan.language}`).join(",")}`);
    if (removedAudioPlans.length > 0) args.jobLog(`GPU normalize removed audio streams: ${removedAudioPlans.map((plan) => `${plan.sourceIdx}:${plan.language}`).join(",")}`);
  };
  const inputAudioSummary = audioStreams.map(streamSummary).join("; ");
  const normalizeScopeText = normalizeOnlyLanguages.length > 0 ? `only ${normalizeOnlyLanguages.join(", ")}` : "all audio languages";
  const stereoPlanText = ensureStereo
    ? `ensure stereo for ${stereoFallbackFirstOnly ? "first selected language" : "each selected non-stereo stream"}`
    : "do not add generated stereo";
  const {
    allIntermediateFiles,
    audioPlans: runtimeAudioPlans,
    audioWork,
    baselineEtaSeconds,
    cleanupAll,
    cleanupFilesForPlan,
    muxWork,
    statsCachePathFor,
    statsErrPathFor,
    totalWork,
    trackStatsCachePath,
    trackStatsPaths,
  } = createAudioPlanRuntimeContext({
    audioPlans,
    sampleRate,
    durationSeconds,
    tmpOutputFilePath,
  });

  return {
    allSourceAudioPlans,
    audioPlans: runtimeAudioPlans,
    copyOriginalAudioPlans,
    fallbackUndetectedAudioPlans,
    describeRemove,
    skippedAudioPlans,
    removedAudioPlans,
    sourceAudioActions,
    inputAudioSummary,
    normalizeScopeText,
    stereoPlanText,
    describePlan,
    describeCopy,
    logDebugPlanSummary,
    statsCachePathFor,
    statsErrPathFor,
    trackStatsCachePath,
    trackStatsPaths,
    audioWork,
    muxWork,
    totalWork,
    baselineEtaSeconds,
    cleanupFilesForPlan,
    allIntermediateFiles,
    cleanupAll,
  };
}

module.exports = {
  buildAudioPlanContext,
};
