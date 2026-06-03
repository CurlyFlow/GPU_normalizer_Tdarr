"use strict";

const {
  DEFAULT_NORMALIZE_ONLY_LANGUAGES,
  DEFAULT_STEREO_LANGUAGE_ORDER,
  FALLBACK_TO_UNDETECTED_AUDIO_TOOLTIP,
  LANGUAGE_ALIASES,
  LEGACY_STEREO_TRACK_ORDER_VALUES,
  NORMALIZE_ONLY_LANGUAGES_TOOLTIP,
  REMOVE_OTHER_LANGUAGES_TOOLTIP,
  STEREO_LANGUAGE_ORDER_TOOLTIP,
} = require("./audioLanguageData");

function isUndetectedLanguage(value) {
  const raw = String(value || "").trim().toLowerCase().split(/[-_]/)[0].replace(/[^a-z0-9]/g, "");
  return !raw || raw === "und" || raw === "unknown" || raw === "unbekannt";
}

function canonicalLanguage(value) {
  const raw = String(value || "").trim().toLowerCase().split(/[-_]/)[0].replace(/[^a-z0-9]/g, "");
  if (isUndetectedLanguage(raw)) return "";
  return LANGUAGE_ALIASES[raw] || raw;
}

function stereoFallbackLanguageOrder(value) {
  const input = String(value ?? "").trim();
  const legacyInput = input.toLowerCase().replace(/[\s_-]+/g, "");
  const raw = !input || LEGACY_STEREO_TRACK_ORDER_VALUES.has(legacyInput) ? DEFAULT_STEREO_LANGUAGE_ORDER : input;
  const seen = new Set();
  return raw.split(/[,;|>:=\s]+/).map(canonicalLanguage).filter((language) => {
    if (!language || seen.has(language)) return false;
    seen.add(language);
    return true;
  });
}

function normalizeOnlyLanguageOrder(value) {
  const input = String(value ?? DEFAULT_NORMALIZE_ONLY_LANGUAGES).trim();
  const raw = input.toLowerCase().replace(/[^a-z0-9*]+/g, "");
  if (!raw || ["all", "allaudio", "allaudiostreams", "allstreams", "normalizeall", "*"].includes(raw)) return [];
  const seen = new Set();
  return input.split(/[,;|>:=\s]+/).map(canonicalLanguage).filter((language) => {
    if (!language || seen.has(language)) return false;
    seen.add(language);
    return true;
  });
}

function sortAudioPlansByLanguage(plans, languageOrder) {
  if (languageOrder.length === 0) return plans.slice();
  const languageRank = new Map(languageOrder.map((language, idx) => [language, idx]));
  return plans.map((plan, idx) => {
    const language = canonicalLanguage(plan.language);
    return { plan, idx, rank: languageRank.has(language) ? languageRank.get(language) : Number.MAX_SAFE_INTEGER };
  }).sort((a, b) => a.rank - b.rank || a.idx - b.idx).map((item) => item.plan);
}

function stereoFallbackLanguageKey(plan) {
  return canonicalLanguage(plan.language) || String(plan.language || "und").trim().toLowerCase() || "und";
}

module.exports = {
  DEFAULT_NORMALIZE_ONLY_LANGUAGES,
  DEFAULT_STEREO_LANGUAGE_ORDER,
  FALLBACK_TO_UNDETECTED_AUDIO_TOOLTIP,
  NORMALIZE_ONLY_LANGUAGES_TOOLTIP,
  REMOVE_OTHER_LANGUAGES_TOOLTIP,
  STEREO_LANGUAGE_ORDER_TOOLTIP,
  canonicalLanguage,
  isUndetectedLanguage,
  normalizeOnlyLanguageOrder,
  sortAudioPlansByLanguage,
  stereoFallbackLanguageKey,
  stereoFallbackLanguageOrder,
};
