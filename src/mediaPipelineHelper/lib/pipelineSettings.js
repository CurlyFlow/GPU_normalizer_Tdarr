"use strict";

function pipelineSettings(inputs) {
  const list = (value) => String(value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const boolean = (value) => {
    if (![true, false, "true", "false"].includes(value)) throw new Error("Invalid media pipeline settings boolean");
    return value === true || value === "true";
  };
  const value = {
    keepLanguages: list(inputs.keepLanguages), removeSubtitleCodecs: list(inputs.removeSubtitleCodecs),
    removeCommentary: boolean(inputs.removeCommentary), removeSdh: boolean(inputs.removeSdh),
    videoPreset: inputs.videoPreset, videoQuality: Number(inputs.videoQuality),
    sidecars: { languages: list(inputs.sidecarLanguages), defaultLanguage: String(inputs.sidecarDefaultLanguage ?? "").trim().toLowerCase(),
      includeForced: boolean(inputs.sidecarIncludeForced), includeUntagged: boolean(inputs.sidecarIncludeUntagged) },
  };
  const keys = ["keepLanguages", "removeSubtitleCodecs", "removeCommentary", "removeSdh", "videoPreset", "videoQuality", "sidecars"];
  if (!value || Object.keys(value).sort().join() !== keys.sort().join()
      || ![value.keepLanguages, value.removeSubtitleCodecs].every((list) => Array.isArray(list)
        && list.length <= 64 && list.every((s) => typeof s === "string" && /^[a-z0-9_]+$/.test(s)))
      || typeof value.removeCommentary !== "boolean" || typeof value.removeSdh !== "boolean"
      || !/^p[1-7]$/.test(value.videoPreset) || !Number.isInteger(value.videoQuality)
      || value.videoQuality < 0 || value.videoQuality > 51) throw new Error("Invalid media pipeline settings");
  const sidecars = value.sidecars;
  if (!sidecars || Object.keys(sidecars).sort().join() !== "defaultLanguage,includeForced,includeUntagged,languages"
      || !Array.isArray(sidecars.languages) || !sidecars.languages.every((s) => /^[a-z]{2,3}$/.test(s))
      || !/^[a-z]{0,3}$/.test(sidecars.defaultLanguage) || typeof sidecars.includeForced !== "boolean"
      || typeof sidecars.includeUntagged !== "boolean") throw new Error("Invalid subtitle companion settings");
  return value;
}

module.exports = { pipelineSettings };
