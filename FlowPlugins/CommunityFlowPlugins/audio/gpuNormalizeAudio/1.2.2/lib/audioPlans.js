"use strict";

const {
  channelCount,
  isMp4Container,
  mp4TrueHdOutputArgs,
  primaryAudioChannels,
  shouldEncodeCopiedAudioForMp4,
  sourceChannelLayout,
  streamSummary,
} = require("./audioChannelHelpers");
const {
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
} = require("./audioLanguageHelpers");

module.exports = {
  DEFAULT_NORMALIZE_ONLY_LANGUAGES,
  DEFAULT_STEREO_LANGUAGE_ORDER,
  NORMALIZE_ONLY_LANGUAGES_TOOLTIP,
  REMOVE_OTHER_LANGUAGES_TOOLTIP,
  STEREO_LANGUAGE_ORDER_TOOLTIP,
  channelCount,
  isMp4Container,
  mp4TrueHdOutputArgs,
  normalizeOnlyLanguageOrder,
  primaryAudioChannels,
  selectStereoFallbackSourcePlans,
  shouldEncodeCopiedAudioForMp4,
  sortAudioPlansByLanguage,
  sourceChannelLayout,
  stereoFallbackLanguageKey,
  stereoFallbackLanguageOrder,
  streamSummary,
};
