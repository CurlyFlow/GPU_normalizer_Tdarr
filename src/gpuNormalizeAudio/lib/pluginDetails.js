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
  tags: "audio,normalize,loudnorm,gpu",
  isStartPlugin: false,
  pType: "",
  requiresVersion: "2.31.01",
  sidebarPosition: -1,
  icon: "faVolumeUp",
  inputs: [
    { label: "Debug Logging", name: "debugLogging", type: "boolean", defaultValue: false, inputUI: { type: "switch" }, tooltip: "Default: off. Enables full successful FFmpeg and runtime output in job logs for troubleshooting." },
    { label: "Track Order", name: "stereoFallbackOrder", type: "string", defaultValue: DEFAULT_STEREO_LANGUAGE_ORDER, inputUI: { type: "text" }, tooltip: STEREO_LANGUAGE_ORDER_TOOLTIP },
    { label: "Normalize ONLY Languages", name: "normalizeOnlyLanguages", type: "string", defaultValue: DEFAULT_NORMALIZE_ONLY_LANGUAGES, inputUI: { type: "text" }, tooltip: NORMALIZE_ONLY_LANGUAGES_TOOLTIP },
    { label: "Remove Other Languages", name: "removeOtherLanguages", type: "boolean", defaultValue: false, inputUI: { type: "switch" }, tooltip: REMOVE_OTHER_LANGUAGES_TOOLTIP },
    { label: "Fallback To Undetected Audio", name: "fallbackToUndetectedAudio", type: "boolean", defaultValue: true, inputUI: { type: "switch" }, tooltip: FALLBACK_TO_UNDETECTED_AUDIO_TOOLTIP },
    { label: "Add Generated 2-Channel Track", name: "ensureStereo", type: "boolean", defaultValue: true, inputUI: { type: "switch" }, tooltip: "Default: on. Adds a normalized stereo downmix when the selected audio would otherwise have no 2-channel track." },
    { label: "Only Generate 2-Channel For First Language", name: "stereoFallbackFirstOnly", type: "boolean", defaultValue: true, inputUI: { type: "switch" }, tooltip: "Default: on. On adds at most one generated stereo track for the first selected language in Track Order. Off adds generated stereo for every selected non-stereo audio stream." },
    { label: "Max Concurrent CPU Tasks", name: "maxConcurrentCpuJobs", type: "string", defaultValue: "1", inputUI: { type: "text" }, tooltip: "Default: 1. Host-wide CPU concurrency limit across running jobs and plugins for muxing, copy-only runs, and verification. Set 0 to disable the CPU guard." },
    { label: "Max Concurrent GPU Tasks", name: "maxConcurrentJobs", type: "string", defaultValue: "1", inputUI: { type: "text" }, tooltip: "Default: 1. Host-wide GPU concurrency limit across running jobs and plugins. Set 0 to disable the GPU guard." },
    { label: "Audio Bitrate", name: "audioBitrate", type: "string", defaultValue: "192k", inputUI: { type: "text" }, tooltip: "Default: 192k. AAC bitrate for normalized and generated audio tracks. Release parity and performance are validated at 192k." },
    { label: "Prepare Audio For MP4", name: "mp4CompatibleAudio", type: "boolean", defaultValue: false, inputUI: { type: "switch" }, tooltip: "Enable when a later flow step remuxes to MP4. Converts retained MP4-incompatible audio to AAC inside this plugin, including otherwise unchanged files. Keeps this step's container, video and other streams unchanged; already compatible audio is copied." },
    { label: "Integrated Loudness I", name: "i", type: "string", defaultValue: "-18.0", inputUI: { type: "text" }, tooltip: "Default: -18.0. FFmpeg loudnorm integrated loudness target in LUFS." },
    { label: "Loudness Range LRA", name: "lra", type: "string", defaultValue: "7.0", inputUI: { type: "text" }, tooltip: "Default: 7.0. FFmpeg loudnorm loudness range target in LU." },
    { label: "True Peak TP", name: "tp", type: "string", defaultValue: "-2.0", inputUI: { type: "text" }, tooltip: "Default: -2.0. FFmpeg loudnorm true-peak target in dBTP." },
    { label: "Max Gain dB", name: "maxGain", type: "string", defaultValue: "15", inputUI: { type: "text" }, tooltip: "Default: 15. Safety gate in dB. If target loudness needs more gain than this, selected audio is copied instead of normalized. Set 0 to disable." },
  ],
  outputs: [
    { number: 1, tooltip: "Output package with normalized or copied selected audio, generated stereo when enabled, and optional removal of other audio languages." },
    { number: 2, tooltip: "No audio or no selected audio remains. No media or Tdarr entry is deleted by this audio plugin. Connect a downstream rejection or cleanup step if desired." },
  ],
});

module.exports = {
  details,
};
