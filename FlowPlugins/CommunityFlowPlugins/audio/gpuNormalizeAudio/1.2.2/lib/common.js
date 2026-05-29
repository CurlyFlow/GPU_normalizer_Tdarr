"use strict";

const {
  createProgressUpdater,
  ffmpegProgressFraction,
  gpuProgressFraction,
} = require("./progressHelpers");
const {
  logProfileStage,
} = require("./profileHelpers");
const {
  loudnormNumber,
  parseLoudnormJson,
  parseLoudnormJsonBlocks,
} = require("./loudnormParsing");

function q(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function intNum(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function num(value, fallback) {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolInput(value, fallback) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  if (["true", "1", "yes", "y", "on"].includes(raw)) return true;
  if (["false", "0", "no", "n", "off"].includes(raw)) return false;
  return fallback;
}

function envFlag(name, fallback = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  if (["true", "1", "yes", "y", "on"].includes(raw)) return true;
  if (["false", "0", "no", "n", "off"].includes(raw)) return false;
  return fallback;
}

function normalizeNsysSample(value) {
  const raw = String(value || "none").trim().toLowerCase();
  if (["", "none", "off", "false", "0", "no"].includes(raw)) return "none";
  if (["cpu", "process", "process-tree", "tree", "on", "true", "1", "yes"].includes(raw)) return "process-tree";
  if (["system", "system-wide", "all"].includes(raw)) return "system-wide";
  return raw;
}

function langTag(value) {
  const cleaned = String(value || "und").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
  return cleaned || "und";
}

function parseDurationSeconds(inputFileObj) {
  const ffprobeDuration = (((inputFileObj || {}).ffProbeData || {}).format || {}).duration;
  const metaDuration = ((inputFileObj || {}).meta || {}).Duration;
  for (const value of [ffprobeDuration, metaDuration]) {
    const parsed = Number.parseFloat(String(value));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function sampleBytes(format) {
  return String(format).toLowerCase() === "f64le" ? 8 : 4;
}

function cleanLogText(text) {
  const noisyPrefixes = [
    "tdarr_progress ", "frame=", "fps=", "stream_", "bitrate=", "total_size=",
    "out_time", "dup_frames=", "drop_frames=", "speed=", "progress=",
  ];
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== "" && !noisyPrefixes.some((prefix) => trimmed.startsWith(prefix));
    })
    .join("\n");
}

module.exports = {
  boolInput,
  cleanLogText,
  createProgressUpdater,
  envFlag,
  ffmpegProgressFraction,
  gpuProgressFraction,
  intNum,
  langTag,
  logProfileStage,
  loudnormNumber,
  normalizeNsysSample,
  num,
  parseDurationSeconds,
  parseLoudnormJson,
  parseLoudnormJsonBlocks,
  q,
  sampleBytes,
};
