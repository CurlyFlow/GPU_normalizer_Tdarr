"use strict";

const {
  envFlag,
} = require("./common");
const {
  primaryAudioChannels,
} = require("./audioChannelHelpers");

function createPluginPlanHelpers({ audioStreams }) {
  const planLabelFor = (plan) => `audio stream ${plan.sourceIdx}${plan.stereoFallback ? " stereo fallback" : ""}`;
  const sourceChannelsFor = (plan) => primaryAudioChannels(audioStreams[plan.sourceIdx], plan.channels);
  const needsInlineStereoDownmix = (plan) => plan.channels === 2 && sourceChannelsFor(plan) !== 2;
  const stereoFallbackSourceExact = envFlag("LOUDNORM_GPU_STEREO_FALLBACK_SOURCE_EXACT", true);
  const usesStereoFallbackSourcePath = (plan) => stereoFallbackSourceExact && plan.stereoFallback && needsInlineStereoDownmix(plan);

  return {
    needsInlineStereoDownmix,
    planLabelFor,
    sourceChannelsFor,
    stereoFallbackSourceExact,
    usesStereoFallbackSourcePath,
  };
}

module.exports = {
  createPluginPlanHelpers,
};
