"use strict";

const {
  DEFAULT_NORMALIZE_ONLY_LANGUAGES,
  DEFAULT_STEREO_LANGUAGE_ORDER,
  NORMALIZE_ONLY_LANGUAGES_TOOLTIP,
  REMOVE_OTHER_LANGUAGES_TOOLTIP,
  STEREO_LANGUAGE_ORDER_TOOLTIP,
  normalizeOnlyLanguageOrder,
  sortAudioPlansByLanguage,
  stereoFallbackLanguageKey,
  stereoFallbackLanguageOrder,
} = require("./audioLanguageOrder");
const {
  selectStereoFallbackSourcePlans,
} = require("./audioStereoFallbackSelection");

module.exports = {
  DEFAULT_NORMALIZE_ONLY_LANGUAGES,
  DEFAULT_STEREO_LANGUAGE_ORDER,
  NORMALIZE_ONLY_LANGUAGES_TOOLTIP,
  REMOVE_OTHER_LANGUAGES_TOOLTIP,
  STEREO_LANGUAGE_ORDER_TOOLTIP,
  normalizeOnlyLanguageOrder,
  selectStereoFallbackSourcePlans,
  sortAudioPlansByLanguage,
  stereoFallbackLanguageKey,
  stereoFallbackLanguageOrder,
};
