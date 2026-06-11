"use strict";

const {
  DEFAULT_NORMALIZE_ONLY_LANGUAGES,
  DEFAULT_STEREO_LANGUAGE_ORDER,
  FALLBACK_TO_UNDETECTED_AUDIO_TOOLTIP,
  NORMALIZE_ONLY_LANGUAGES_TOOLTIP,
  REMOVE_OTHER_LANGUAGES_TOOLTIP,
  STEREO_LANGUAGE_ORDER_TOOLTIP,
} = require("./audioLanguageOrder");

const details = () => ({
  name: "GPU Normalize Audio",
  description: "Normalize selected or all audio streams with FFmpeg loudnorm-compatible planning and GPU-assisted rendering, then mux them back while preserving video, subtitle, attachment, data, chapters, and metadata.",
  style: { borderColor: "#38bdf8" },
  tags: "video,audio,normalize,loudnorm,gpu",
  isStartPlugin: false,
  pType: "",
  requiresVersion: "2.11.01",
  sidebarPosition: -1,
  icon: "faVolumeUp",
  inputs: [
    { label: "Track Order", name: "stereoFallbackOrder", type: "string", defaultValue: DEFAULT_STEREO_LANGUAGE_ORDER, inputUI: { type: "text" }, tooltip: STEREO_LANGUAGE_ORDER_TOOLTIP },
    { label: "Normalize ONLY Languages", name: "normalizeOnlyLanguages", type: "string", defaultValue: DEFAULT_NORMALIZE_ONLY_LANGUAGES, inputUI: { type: "text" }, tooltip: NORMALIZE_ONLY_LANGUAGES_TOOLTIP },
    { label: "Remove Other Languages", name: "removeOtherLanguages", type: "boolean", defaultValue: true, inputUI: { type: "checkbox" }, tooltip: REMOVE_OTHER_LANGUAGES_TOOLTIP },
    { label: "Fallback To Undetected Audio", name: "fallbackToUndetectedAudio", type: "boolean", defaultValue: true, inputUI: { type: "checkbox" }, tooltip: FALLBACK_TO_UNDETECTED_AUDIO_TOOLTIP },
    { label: "Add Generated 2-Channel Track", name: "ensureStereo", type: "boolean", defaultValue: true, inputUI: { type: "checkbox" }, tooltip: "Default: on. Adds a normalized stereo downmix when the selected audio would otherwise have no 2-channel track." },
    { label: "Only Generate 2-Channel For First Language", name: "stereoFallbackFirstOnly", type: "boolean", defaultValue: true, inputUI: { type: "checkbox" }, tooltip: "Default: on. On adds at most one generated stereo track for the first selected language in Track Order. Off adds generated stereo for every selected non-stereo audio stream." },
    { label: "Max Concurrent Jobs", name: "maxConcurrentJobs", type: "string", defaultValue: "1", inputUI: { type: "text" }, tooltip: "Default: 1. Limits simultaneous GPU Normalize Audio jobs using the plugin lock. Set 0 to disable the guard." },
    { label: "Audio Bitrate", name: "audioBitrate", type: "string", defaultValue: "192k", inputUI: { type: "text" }, tooltip: "Default: 192k. AAC bitrate for normalized and generated audio tracks. Release parity and performance are validated at 192k." },
    { label: "Integrated Loudness I", name: "i", type: "string", defaultValue: "-18.0", inputUI: { type: "text" }, tooltip: "Default: -18.0. FFmpeg loudnorm integrated loudness target in LUFS." },
    { label: "Loudness Range LRA", name: "lra", type: "string", defaultValue: "7.0", inputUI: { type: "text" }, tooltip: "Default: 7.0. FFmpeg loudnorm loudness range target in LU." },
    { label: "True Peak TP", name: "tp", type: "string", defaultValue: "-2.0", inputUI: { type: "text" }, tooltip: "Default: -2.0. FFmpeg loudnorm true-peak target in dBTP." },
    { label: "Max Gain dB", name: "maxGain", type: "string", defaultValue: "15", inputUI: { type: "text" }, tooltip: "Default: 15. Safety gate in dB. If target loudness needs more gain than this, selected audio is copied instead of normalized. Set 0 to disable." },
    { label: "Debug Logging", name: "debugLogging", type: "boolean", defaultValue: false, inputUI: { type: "checkbox" }, tooltip: "Default: off. Enables full successful FFmpeg and runtime output in job logs for troubleshooting." },
  ],
  outputs: [
    { number: 1, tooltip: "Output package with normalized or copied selected audio, generated stereo when enabled, and optional removal of other audio languages." },
  ],
});

module.exports = {
  details,
};
