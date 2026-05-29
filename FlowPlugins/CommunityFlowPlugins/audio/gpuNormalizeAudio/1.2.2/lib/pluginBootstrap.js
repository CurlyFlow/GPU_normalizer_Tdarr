"use strict";

const {
  loudnormNumber,
} = require("./common");

function requireAny(paths) {
  const errors = [];
  for (const modulePath of paths) {
    try {
      return require(modulePath);
    } catch (err) {
      errors.push(`${modulePath}: ${err.message}`);
    }
  }
  throw new Error(`Unable to load Tdarr helper module. Tried: ${errors.join(" | ")}`);
}

function loadFlowHelpers() {
  const { getContainer, getFileName, getPluginWorkDir } = requireAny([
    "../../../../../FlowHelpers/1.0.0/fileUtils",
    "../../../../FlowHelpers/1.0.0/fileUtils",
  ]);
  return { getContainer, getFileName, getPluginWorkDir };
}

function loadTdarrLib() {
  return requireAny([
    "../../../../../../methods/lib",
    "../../../../../methods/lib",
  ])();
}

function hasOwnInput(inputs, name) {
  return Object.prototype.hasOwnProperty.call(inputs || {}, name);
}

function loadInputsPreservingExplicitBlanks(lib, rawInputs, details) {
  const sourceInputs = rawInputs && typeof rawInputs === "object" ? rawInputs : {};
  const explicitBlankNormalizeOnly = hasOwnInput(sourceInputs, "normalizeOnlyLanguages")
    && String(sourceInputs.normalizeOnlyLanguages ?? "").trim() === "";
  const loadedInputs = lib.loadDefaultValues(sourceInputs, details);
  if (explicitBlankNormalizeOnly) loadedInputs.normalizeOnlyLanguages = "";
  return loadedInputs;
}

function initializePluginInputs(args, details) {
  const lib = loadTdarrLib();
  const flowHelpers = loadFlowHelpers();
  args.inputs = loadInputsPreservingExplicitBlanks(lib, args.inputs, details);
  return flowHelpers;
}

function cachedCpuLoudnorm(args, sourceIdx, channels = null, allowSourceOnly = true) {
  const raw = ((args.variables || {}).gpuNormalizeAudioCpuLoudnorm || {});
  const channelKey = channels ? `${sourceIdx}:${channels}` : "";
  const value = (channelKey ? raw[channelKey] : null) || (allowSourceOnly ? (raw[String(sourceIdx)] || raw[sourceIdx]) : null);
  if (!value || typeof value !== "object") return null;
  for (const key of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) {
    loudnormNumber(value, key);
  }
  return value;
}

module.exports = {
  cachedCpuLoudnorm,
  initializePluginInputs,
};
