"use strict";

const {
  primaryAudioChannels,
} = require("./audioChannelHelpers");
const {
  stereoFallbackLanguageKey,
} = require("./audioLanguageOrder");

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

module.exports = {
  selectStereoFallbackSourcePlans,
};
