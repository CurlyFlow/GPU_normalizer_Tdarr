"use strict";

const fs = require("fs");

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

function niceCommand(command, niceLevel) {
  return niceLevel > 0 ? `nice -n ${niceLevel} ${command}` : command;
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

function parseLoudnormJson(text) {
  const full = String(text || "");
  const targetOffsetIdx = full.lastIndexOf("target_offset");
  if (targetOffsetIdx === -1) throw new Error("Failed to find target_offset in loudnorm output");
  const closingBraceIdx = full.indexOf("}", targetOffsetIdx);
  if (closingBraceIdx === -1) throw new Error("Failed to find closing brace in loudnorm output");
  const openingBraceIdx = full.lastIndexOf("{", targetOffsetIdx);
  if (openingBraceIdx === -1) throw new Error("Failed to find opening brace in loudnorm output");
  return JSON.parse(full.slice(openingBraceIdx, closingBraceIdx + 1));
}

function parseLoudnormJsonBlocks(text) {
  const full = String(text || "");
  const blocks = [];
  let searchFrom = 0;
  while (true) {
    const targetOffsetIdx = full.indexOf("target_offset", searchFrom);
    if (targetOffsetIdx === -1) break;
    const closingBraceIdx = full.indexOf("}", targetOffsetIdx);
    if (closingBraceIdx === -1) break;
    const openingBraceIdx = full.lastIndexOf("{", targetOffsetIdx);
    if (openingBraceIdx === -1) break;
    blocks.push(JSON.parse(full.slice(openingBraceIdx, closingBraceIdx + 1)));
    searchFrom = closingBraceIdx + 1;
  }
  return blocks;
}

function parseLoudnormJsonFromOutputOrFile(outputText, fallbackPath) {
  let loudnormText = String(outputText || "");
  if (!loudnormText.includes("target_offset") && fallbackPath && fs.existsSync(fallbackPath)) {
    loudnormText = fs.readFileSync(fallbackPath, "utf8");
  }
  return parseLoudnormJson(loudnormText);
}

function parseLoudnormJsonBlocksFromOutputs(outputText, fallbackPaths) {
  let loudnormText = String(outputText || "");
  for (const loudnormPath of fallbackPaths || []) {
    if (loudnormPath && fs.existsSync(loudnormPath)) {
      loudnormText += `\n${fs.readFileSync(loudnormPath, "utf8")}`;
    }
  }
  return parseLoudnormJsonBlocks(loudnormText);
}

function loudnormNumber(values, key) {
  const raw = String((values || {})[key]);
  // FFmpeg can flush a new below-gate filter instance at EOF. Tdarr uses
  // that final report and skips its unbounded required gain, preserving input.
  const belowGate = values && values.input_i === "-inf" && values.target_offset === "inf"
    && Number(values.input_lra) === 0 && Number(values.input_thresh) === -70;
  if (belowGate && key === "input_i") return -Infinity;
  if (belowGate && key === "target_offset") return Infinity;
  if (belowGate && key === "input_tp" && raw === "-inf") return -Infinity;
  const parsed = Number(raw);
  if (!raw.trim() || !Number.isFinite(parsed)) {
    const safeValue = /^(?:[-+]?\d+(?:\.\d+)?|[-+]?inf|nan|undefined|null)$/i.test(raw) ? raw : "non-numeric";
    throw new Error(`GPU normalize: invalid loudnorm ${key} (${safeValue})`);
  }
  return parsed;
}

function formatEta(seconds) {
  const value = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const hrs = Math.floor(value / 3600);
  const mins = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function parseTimestampSeconds(value) {
  const parts = String(value || "").trim().split(":");
  if (parts.length !== 3) return 0;
  const hrs = Number.parseFloat(parts[0]);
  const mins = Number.parseFloat(parts[1]);
  const secs = Number.parseFloat(parts[2]);
  if (![hrs, mins, secs].every(Number.isFinite)) return 0;
  return hrs * 3600 + mins * 60 + secs;
}

function ffmpegProgressFraction(line, durationSeconds) {
  if (!(durationSeconds > 0)) return null;
  const microMatch = String(line).match(/^out_time_(?:us|ms)=([0-9]+)/);
  if (microMatch) {
    const seconds = Number.parseInt(microMatch[1], 10) / 1000000;
    return Math.max(0, Math.min(1, seconds / durationSeconds));
  }
  const timeMatch = String(line).match(/^out_time=([^\s]+)/);
  if (timeMatch) {
    return Math.max(0, Math.min(1, parseTimestampSeconds(timeMatch[1]) / durationSeconds));
  }
  return null;
}

function gpuProgressFraction(line) {
  const match = String(line).match(/^tdarr_progress\s+phase=\S+\s+fraction=([0-9.]+)/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(1, parsed));
}

function createProgressUpdater(args, totalWork, baselineSeconds = 0) {
  const started = Date.now();
  let lastPercentage = 0;
  let lastUpdate = 0;
  let lastEta = null;
  return (workDone, force = false) => {
    if (typeof args.updateWorker !== "function" || !(totalWork > 0)) return;
    const now = Date.now();
    const percentage = Math.max(lastPercentage, Math.min(99.9, (workDone / totalWork) * 100));
    if (!force && now - lastUpdate < 1000 && percentage - lastPercentage < 0.1) return;
    const elapsed = (now - started) / 1000;
    if (percentage <= 0) {
      const baselineEta = Math.max(0, baselineSeconds - elapsed);
      args.updateWorker({ percentage: 0, ETA: formatEta(baselineEta) });
      lastUpdate = now;
      lastEta = baselineEta > 0 ? baselineEta : null;
      return;
    }
    const rateEstimate = (elapsed / percentage) * (100 - percentage);
    let estimate = rateEstimate;
    if (baselineSeconds > 0) {
      const baselineCountdown = Math.max(0, baselineSeconds - elapsed);
      const lagWindow = Math.max(1, baselineSeconds * 0.3);
      const lagRatio = Math.max(0, (elapsed - (baselineSeconds * 0.7)) / lagWindow);
      const progressWeight = Math.min(0.6, lagRatio * 0.25);
      estimate = baselineCountdown + ((Math.max(rateEstimate, baselineCountdown) - baselineCountdown) * progressWeight);
    }
    let eta = estimate;
    if (lastEta !== null) {
      const sinceLast = Math.max(0, (now - lastUpdate) / 1000);
      const countdownEta = Math.max(0, lastEta - sinceLast);
      eta = estimate > countdownEta
        ? countdownEta + ((estimate - countdownEta) * 0.2)
        : estimate;
    }
    args.updateWorker({ percentage: Number(percentage.toFixed(2)), ETA: formatEta(eta) });
    lastPercentage = percentage;
    lastUpdate = now;
    lastEta = eta;
  };
}

function profileValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value.toFixed(6) : String(value);
  return String(value).replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.=:+-]/g, "_");
}

function logProfileStage(args, fields) {
  if (args.logFullCliOutput !== true) return;
  args.jobLog(`profile_stage ${Object.entries(fields).map(([key, value]) => `${key}=${profileValue(value)}`).join(" ")}`);
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
  niceCommand,
  normalizeNsysSample,
  num,
  parseDurationSeconds,
  parseLoudnormJson,
  parseLoudnormJsonBlocks,
  parseLoudnormJsonBlocksFromOutputs,
  parseLoudnormJsonFromOutputOrFile,
  q,
  sampleBytes,
};
