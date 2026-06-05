"use strict";

const {
  isUndetectedLanguage,
  stereoFallbackLanguageKey,
} = require("./audioLanguageOrder");
const {
  selectStereoFallbackSourcePlans,
} = require("./audioStereoFallbackSelection");

function createAudioSelection({
  sourceAudioPlans,
  normalizeOnlyLanguages,
  removeOtherLanguages,
  fallbackToUndetectedAudio = true,
  ensureStereo,
  stereoFallbackFirstOnly,
  createStereoFallbackPlan,
}) {
  const normalizeOnlyLanguageSet = new Set(normalizeOnlyLanguages);
  const shouldRemoveOtherLanguages = removeOtherLanguages && normalizeOnlyLanguages.length > 0;
  const selectedSourcePlans = normalizeOnlyLanguages.length > 0
    ? sourceAudioPlans.filter((plan) => normalizeOnlyLanguageSet.has(stereoFallbackLanguageKey(plan)))
    : sourceAudioPlans.slice();
  const selectedSourceKeys = new Set(selectedSourcePlans.map((plan) => plan.sourceIdx));
  const fallbackUndetectedAudioPlans = shouldRemoveOtherLanguages && fallbackToUndetectedAudio && selectedSourcePlans.length === 0
    ? sourceAudioPlans.filter((plan) => isUndetectedLanguage(plan.language))
    : [];
  const fallbackSourceKeys = new Set(fallbackUndetectedAudioPlans.map((plan) => plan.sourceIdx));
  const selectedLanguageKeys = Array.from(new Set(selectedSourcePlans.map(stereoFallbackLanguageKey)));
  const sourceAudioActions = sourceAudioPlans.map((plan) => {
    if (selectedSourceKeys.has(plan.sourceIdx)) return { action: "normalize", plan, reason: "selected_language" };
    if (shouldRemoveOtherLanguages) {
      if (fallbackSourceKeys.has(plan.sourceIdx)) return { action: "copy", plan, reason: "fallback_undetected" };
      return { action: "remove", plan, reason: "not_selected" };
    }
    return { action: "copy", plan, reason: "not_selected" };
  });
  const copiedSourceActions = sourceAudioActions.filter((entry) => entry.action === "copy");
  const removedSourceActions = sourceAudioActions.filter((entry) => entry.action === "remove");
  const skippedAudioPlans = copiedSourceActions.map((entry) => entry.plan);
  const removedAudioPlans = removedSourceActions.map((entry) => entry.plan);
  const audioPlans = selectedSourcePlans.slice();
  let nextPlanIdx = Math.max(0, ...audioPlans.map((plan) => plan.idx)) + 1;

  if (ensureStereo) {
    const sourcePlans = selectStereoFallbackSourcePlans(audioPlans, stereoFallbackFirstOnly);
    let fallbackOrdinal = 0;
    for (const sourcePlan of sourcePlans) {
      audioPlans.push(createStereoFallbackPlan({
        fallbackOrdinal,
        idx: nextPlanIdx++,
        sourceIdx: sourcePlan.sourceIdx,
      }));
      fallbackOrdinal += 1;
    }
  }

  return {
    audioPlans,
    copyOriginalAudioPlans: shouldRemoveOtherLanguages
      ? sourceAudioActions.filter((entry) => entry.action !== "remove").map((entry) => entry.plan)
      : null,
    fallbackUndetectedAudioPlans,
    removedAudioPlans,
    selectedLanguageKeys,
    shouldRemoveOtherLanguages,
    skippedAudioPlans,
    sourceAudioActions,
  };
}

module.exports = {
  createAudioSelection,
};
