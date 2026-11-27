"use strict";

const {
  primaryAudioChannels,
} = require("./audioChannelHelpers");
const {
  isUndetectedLanguage,
  stereoFallbackLanguageKey,
} = require("./audioLanguageOrder");

function createAudioActionSet({
  sourceAudioActions,
  normalizePlans,
  fallbackUndetectedAudioPlans,
  selectedLanguageKeys,
  shouldRemoveOtherLanguages,
}) {
  const sourceActions = sourceAudioActions.slice();
  const normalize = normalizePlans.slice();
  const copy = sourceActions
    .filter((entry) => entry.action === "copy")
    .map((entry) => entry.plan);
  const remove = sourceActions
    .filter((entry) => entry.action === "remove")
    .map((entry) => entry.plan);
  const fallbackUndetected = fallbackUndetectedAudioPlans.slice();

  return {
    source: sourceActions,
    normalize,
    copy,
    remove,
    fallback: {
      stereo: normalize.filter((plan) => plan.stereoFallback),
      undetected: fallbackUndetected,
    },
    muxInputs: {
      copyOriginal: shouldRemoveOtherLanguages
        ? sourceActions.filter((entry) => entry.action !== "remove").map((entry) => entry.plan)
        : null,
    },
    selectedLanguageKeys: selectedLanguageKeys.slice(),
    shouldRemoveOtherLanguages,
  };
}

function stereoFallbackSourceScore(plan) {
  const channels = primaryAudioChannels(plan, 0);
  if (channels === 6) return 0;
  if (channels === 5) return 1;
  if (channels === 8) return 2;
  if (channels > 2) return 3;
  return 4;
}

function bestStereoFallbackSource(plans) {
  return plans.slice().sort((a, b) => {
    const scoreDiff = stereoFallbackSourceScore(a) - stereoFallbackSourceScore(b);
    if (scoreDiff !== 0) return scoreDiff;
    return a.sourceIdx - b.sourceIdx;
  })[0] || null;
}

function selectStereoFallbackSourcePlans(audioPlans, firstOnly) {
  const sourcePlans = audioPlans.filter((plan) => plan.channels !== 2);
  if (!firstOnly) return sourcePlans;
  const firstPlan = audioPlans[0] || null;
  if (!firstPlan) return [];
  const firstLanguage = stereoFallbackLanguageKey(firstPlan);
  const sameLanguagePlans = audioPlans.filter((plan) => stereoFallbackLanguageKey(plan) === firstLanguage);
  if (sameLanguagePlans.some((plan) => plan.channels === 2)) return [];
  const bestPlan = bestStereoFallbackSource(sameLanguagePlans.filter((plan) => plan.channels !== 2));
  return bestPlan ? [bestPlan] : [];
}

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

  const actionSet = createAudioActionSet({
    sourceAudioActions,
    normalizePlans: audioPlans,
    fallbackUndetectedAudioPlans,
    selectedLanguageKeys,
    shouldRemoveOtherLanguages,
  });

  return {
    actionSet,
    audioPlans: actionSet.normalize,
    copyOriginalAudioPlans: actionSet.muxInputs.copyOriginal,
    fallbackUndetectedAudioPlans,
    removedAudioPlans: actionSet.remove,
    selectedLanguageKeys,
    shouldRemoveOtherLanguages,
    skippedAudioPlans: actionSet.copy,
    sourceAudioActions: actionSet.source,
  };
}

module.exports = {
  createAudioSelection,
};
