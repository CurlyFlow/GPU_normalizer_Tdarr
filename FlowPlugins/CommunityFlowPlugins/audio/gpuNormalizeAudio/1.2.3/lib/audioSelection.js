"use strict";

const {
  stereoFallbackLanguageKey,
} = require("./audioLanguageOrder");
const {
  selectStereoFallbackSourcePlans,
} = require("./audioStereoFallbackSelection");

function createAudioSelection({
  sourceAudioPlans,
  normalizeOnlyLanguages,
  removeOtherLanguages,
  ensureStereo,
  stereoFallbackFirstOnly,
  createStereoFallbackPlan,
}) {
  const normalizeOnlyLanguageSet = new Set(normalizeOnlyLanguages);
  const shouldRemoveOtherLanguages = removeOtherLanguages && normalizeOnlyLanguages.length > 0;
  const selectedSourcePlans = normalizeOnlyLanguages.length > 0
    ? sourceAudioPlans.filter((plan) => normalizeOnlyLanguageSet.has(stereoFallbackLanguageKey(plan)))
    : sourceAudioPlans.slice();
  const selectedLanguageKeys = Array.from(new Set(selectedSourcePlans.map(stereoFallbackLanguageKey)));
  const normalizedSourceKeys = new Set(selectedSourcePlans.map((plan) => plan.sourceIdx));
  const nonSelectedAudioPlans = sourceAudioPlans.filter((plan) => !normalizedSourceKeys.has(plan.sourceIdx));
  const skippedAudioPlans = shouldRemoveOtherLanguages ? [] : nonSelectedAudioPlans;
  const removedAudioPlans = shouldRemoveOtherLanguages ? nonSelectedAudioPlans : [];
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
    copyOriginalAudioPlans: shouldRemoveOtherLanguages ? selectedSourcePlans : null,
    removedAudioPlans,
    selectedLanguageKeys,
    shouldRemoveOtherLanguages,
    skippedAudioPlans,
  };
}

module.exports = {
  createAudioSelection,
};
