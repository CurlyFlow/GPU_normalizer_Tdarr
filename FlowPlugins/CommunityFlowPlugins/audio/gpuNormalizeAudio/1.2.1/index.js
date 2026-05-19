"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

const fs = require("fs");
const childProcess = require("child_process");

const PLUGIN_VERSION = "1.2.1";
const PLUGIN_ROOT = __dirname;
const RUNTIME_ROOT = `${PLUGIN_ROOT}/runtime`;
const RUNTIME_BIN = `${RUNTIME_ROOT}/bin`;
const RUNTIME_CUDA = `${RUNTIME_ROOT}/cuda`;

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
    "../../../../FlowHelpers/1.0.0/fileUtils",
    "../../../FlowHelpers/1.0.0/fileUtils",
  ]);
  return { getContainer, getFileName, getPluginWorkDir };
}

function loadTdarrLib() {
  return requireAny([
    "../../../../../methods/lib",
    "../../../../methods/lib",
  ])();
}

function q(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function intNum(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function primaryAudioChannels(stream, fallback) {
  const parsed = Number.parseInt(String((stream || {}).channels), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sourceChannelLayout(stream, channels) {
  const raw = String((stream || {}).channel_layout || "").trim();
  if (!raw || raw === "unknown") return "";
  if (!/^[A-Za-z0-9_.()+-]+$/.test(raw)) return "";
  if (channels === 2 && raw !== "stereo") return "";
  const codec = String((stream || {}).codec_name || (stream || {}).codec || "").toLowerCase();
  if (channels === 6 && raw === "5.1" && codec === "ac3") return "5.1(side)";
  return raw;
}

function channelCount(value, primaryAudioStream, fallback) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (raw === "" || raw === "auto" || raw === "source") return primaryAudioChannels(primaryAudioStream, fallback);
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : primaryAudioChannels(primaryAudioStream, fallback);
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

function hasOwnInput(inputs, name) {
  return Object.prototype.hasOwnProperty.call(inputs || {}, name);
}

function loadInputsPreservingExplicitBlanks(lib, rawInputs) {
  const sourceInputs = rawInputs && typeof rawInputs === "object" ? rawInputs : {};
  const explicitBlankNormalizeOnly = hasOwnInput(sourceInputs, "normalizeOnlyLanguages")
    && String(sourceInputs.normalizeOnlyLanguages ?? "").trim() === "";
  const loadedInputs = lib.loadDefaultValues(sourceInputs, details);
  if (explicitBlankNormalizeOnly) loadedInputs.normalizeOnlyLanguages = "";
  return loadedInputs;
}

const DEFAULT_STEREO_LANGUAGE_ORDER = "eng, en";
const DEFAULT_NORMALIZE_ONLY_LANGUAGES = "eng, en";
const LEGACY_STEREO_TRACK_ORDER_VALUES = new Set(["end", "aftersource", "source", "near", "besidesource", "first", "stereofirst", "before"]);
const LANGUAGE_ALIASES = {
  en: "eng", eng: "eng",
  de: "deu", deu: "deu", ger: "deu",
  fr: "fra", fra: "fra", fre: "fra",
  es: "spa", spa: "spa",
  it: "ita", ita: "ita",
  pt: "por", por: "por", pob: "por",
  ja: "jpn", jpn: "jpn",
  ko: "kor", kor: "kor",
  zh: "zho", zho: "zho", chi: "zho", cmn: "zho", yue: "zho",
  ru: "rus", rus: "rus",
  uk: "ukr", ukr: "ukr",
  pl: "pol", pol: "pol",
  nl: "nld", nld: "nld", dut: "nld",
  sv: "swe", swe: "swe",
  da: "dan", dan: "dan",
  no: "nor", nb: "nor", nn: "nor", nor: "nor",
  fi: "fin", fin: "fin",
  tr: "tur", tur: "tur",
  ar: "ara", ara: "ara",
  he: "heb", iw: "heb", heb: "heb",
  hi: "hin", hin: "hin",
  th: "tha", tha: "tha",
  vi: "vie", vie: "vie",
  id: "ind", ind: "ind",
  ms: "msa", msa: "msa", may: "msa",
  el: "ell", ell: "ell", gre: "ell",
  ro: "ron", ron: "ron", rum: "ron",
  hu: "hun", hun: "hun",
  cs: "ces", ces: "ces", cze: "ces",
  sk: "slk", slk: "slk", slo: "slk",
  bg: "bul", bul: "bul",
  hr: "hrv", hrv: "hrv",
  sr: "srp", srp: "srp",
  sl: "slv", slv: "slv",
  lt: "lit", lit: "lit",
  lv: "lav", lav: "lav",
  et: "est", est: "est",
  ca: "cat", cat: "cat",
  eu: "eus", eus: "eus", baq: "eus",
  gl: "glg", glg: "glg",
};
const TRACK_ORDER_COPY_PRESETS = [
  "English first: eng, en",
  "German first, then English: deu, ger, de, eng, en",
  "English first, then German: eng, en, deu, ger, de",
  "Japanese/anime first: jpn, ja, eng, en, deu, ger, de",
  "Korean first: kor, ko, eng, en, deu, ger, de",
  "Chinese first: zho, chi, zh, eng, en, deu, ger, de",
  "European common: eng, en, deu, ger, de, fra, fre, fr, spa, es, ita, it, por, pt, nld, dut, nl",
  "Nordic common: eng, en, swe, sv, dan, da, nor, no, fin, fi",
  "Slavic common: eng, en, rus, ru, ukr, uk, pol, pl, ces, cze, cs, slk, slo, sk",
].join(" | ");
const COMMON_LANGUAGE_CODES = [
  "English: eng, en",
  "German: deu, ger, de",
  "French: fra, fre, fr",
  "Spanish: spa, es",
  "Italian: ita, it",
  "Portuguese: por, pt",
  "Japanese: jpn, ja",
  "Korean: kor, ko",
  "Chinese: zho, chi, zh",
  "Russian: rus, ru",
  "Ukrainian: ukr, uk",
  "Polish: pol, pl",
  "Dutch: nld, dut, nl",
  "Swedish: swe, sv",
  "Danish: dan, da",
  "Norwegian: nor, no",
  "Finnish: fin, fi",
  "Turkish: tur, tr",
  "Arabic: ara, ar",
  "Hebrew: heb, he",
  "Hindi: hin, hi",
  "Thai: tha, th",
  "Vietnamese: vie, vi",
  "Indonesian: ind, id",
  "Malay: msa, may, ms",
  "Greek: ell, gre, el",
  "Romanian: ron, rum, ro",
  "Hungarian: hun, hu",
  "Czech: ces, cze, cs",
  "Slovak: slk, slo, sk",
  "Bulgarian: bul, bg",
  "Croatian: hrv, hr",
  "Serbian: srp, sr",
  "Slovenian: slv, sl",
  "Lithuanian: lit, lt",
  "Latvian: lav, lv",
  "Estonian: est, et",
  "Catalan: cat, ca",
  "Basque: eus, baq, eu",
  "Galician: glg, gl",
].join("; ");
const STEREO_LANGUAGE_ORDER_TOOLTIP = `Comma-separated language priority used for output order and generated 2-channel fallback. This does not limit which languages are normalized; use Normalize ONLY Languages for that. Language order uses source metadata and cannot fix missing/wrong tags. Default/copy: ${DEFAULT_STEREO_LANGUAGE_ORDER}. Copy presets: ${TRACK_ORDER_COPY_PRESETS}. Common codes: ${COMMON_LANGUAGE_CODES}.`;
const NORMALIZE_ONLY_LANGUAGES_TOOLTIP = `Default/copy: ${DEFAULT_NORMALIZE_ONLY_LANGUAGES}. Enter language code(s), for example eng,en or deu,ger,de, to normalize only those language groups; all other audio streams are copied unchanged. Clear this field to normalize every audio stream. If none of the listed languages exists, all audio streams are copied unchanged. Common codes: ${COMMON_LANGUAGE_CODES}.`;

function canonicalLanguage(value) {
  const raw = String(value || "").trim().toLowerCase().split(/[-_]/)[0].replace(/[^a-z0-9]/g, "");
  if (!raw || raw === "und" || raw === "unknown") return "";
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

function stereoFallbackSourceScore(plan) {
  const channels = primaryAudioChannels(plan, 0);
  if (channels === 6) return 0;
  if (channels === 5) return 1;
  if (channels === 8) return 2;
  if (channels > 2) return 3;
  return 4;
}

function bestStereoFallbackSource(plans) {
  return plans.slice().sort((a, b) => {
    const scoreDiff = stereoFallbackSourceScore(a) - stereoFallbackSourceScore(b);
    if (scoreDiff !== 0) return scoreDiff;
    return a.sourceIdx - b.sourceIdx;
  })[0] || null;
}

function selectStereoFallbackSourcePlans(audioPlans, firstOnly) {
  const sourcePlans = audioPlans.filter((plan) => plan.channels !== 2);
  if (!firstOnly) return sourcePlans;
  const firstPlan = audioPlans[0] || null;
  if (!firstPlan) return [];
  const firstLanguage = stereoFallbackLanguageKey(firstPlan);
  const sameLanguagePlans = audioPlans.filter((plan) => stereoFallbackLanguageKey(plan) === firstLanguage);
  if (sameLanguagePlans.some((plan) => plan.channels === 2)) return [];
  const bestPlan = bestStereoFallbackSource(sameLanguagePlans.filter((plan) => plan.channels !== 2));
  return bestPlan ? [bestPlan] : [];
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

function streamSummary(stream, idx) {
  const tags = (stream || {}).tags || {};
  const language = langTag(tags.language || (stream || {}).language || "und");
  const codec = String((stream || {}).codec_name || (stream || {}).codec || "unknown");
  const channels = primaryAudioChannels(stream, 0);
  const layout = String((stream || {}).channel_layout || "").trim();
  const sampleRate = intNum((stream || {}).sample_rate, 0);
  const title = String(tags.title || "").trim().replace(/\s+/g, " ").slice(0, 80);
  return `#${idx} ${language} ${codec}${channels > 0 ? ` ${channels}ch` : ""}${layout && layout !== "unknown" ? ` ${layout}` : ""}${sampleRate > 0 ? ` ${sampleRate}Hz` : ""}${title ? ` title=\"${title}\"` : ""}`;
}

function missingRuntime(label, path) {
  return new Error(`${label} not found: ${path}. Install the GPU loudnorm runtime bundle in the Tdarr container or set the plugin input to the correct path.`);
}

function ensureReadableRuntime(label, path) {
  if (!fs.existsSync(path)) throw missingRuntime(label, path);
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile()) throw new Error(`${label} is not a file: ${path}`);
    fs.accessSync(path, fs.constants.R_OK);
  } catch (err) {
    throw new Error(`${label} is not readable: ${path}. Tdarr may have installed the runtime helper with invalid permissions; reinstall or repair the plugin package. ${err.message}`);
  }
}

function ensureExecutableRuntime(label, path) {
  if (!fs.existsSync(path)) throw missingRuntime(label, path);
  try {
    fs.accessSync(path, fs.constants.X_OK);
    return;
  } catch (_) {
    // Tdarr/plugin extraction can drop executable bits even when the release package has them.
  }
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile()) throw new Error(`${label} is not a file: ${path}`);
    fs.chmodSync(path, stat.mode | 0o111);
    fs.accessSync(path, fs.constants.X_OK);
  } catch (err) {
    throw new Error(`${label} is not executable: ${path}. Tdarr may have installed the runtime helper without executable permissions; fix the helper permissions or reinstall the plugin package. ${err.message}`);
  }
}

function formatEta(seconds) {
  const value = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const hrs = Math.floor(value / 3600);
  const mins = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
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

function profileValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value.toFixed(6) : String(value);
  return String(value).replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.=:+-]/g, "_");
}

function logProfileStage(args, fields) {
  if (args.logFullCliOutput !== true) return;
  args.jobLog(`profile_stage ${Object.entries(fields).map(([key, value]) => `${key}=${profileValue(value)}`).join(" ")}`);
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

function loudnormNumber(values, key) {
  const parsed = Number.parseFloat(String((values || {})[key]));
  if (!Number.isFinite(parsed)) throw new Error(`GPU normalize: invalid loudnorm ${key}`);
  return parsed;
}

function cachedCpuLoudnorm(args, sourceIdx) {
  const raw = ((args.variables || {}).gpuNormalizeAudioCpuLoudnorm || {});
  const value = raw[String(sourceIdx)] || raw[sourceIdx] || null;
  if (!value || typeof value !== "object") return null;
  for (const key of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) {
    loudnormNumber(value, key);
  }
  return value;
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
    if (percentage <= 0) {
      const baselineEta = Math.max(0, baselineSeconds);
      args.updateWorker({ percentage: 0, ETA: formatEta(baselineEta) });
      lastUpdate = now;
      lastEta = baselineEta > 0 ? baselineEta : null;
      return;
    }
    const elapsed = (now - started) / 1000;
    const rateEstimate = (elapsed / percentage) * (100 - percentage);
    const baselineEstimate = baselineSeconds > 0 ? baselineSeconds * ((100 - percentage) / 100) : 0;
    const estimate = Math.max(rateEstimate, baselineEstimate);
    let eta = estimate;
    if (lastEta !== null) {
      const sinceLast = Math.max(0, (now - lastUpdate) / 1000);
      const countdownEta = Math.max(0, lastEta - sinceLast);
      eta = Math.max(baselineEstimate, Math.min(estimate, countdownEta));
    }
    args.updateWorker({ percentage: Number(percentage.toFixed(2)), ETA: formatEta(eta) });
    lastPercentage = percentage;
    lastUpdate = now;
    lastEta = eta;
  };
}

function runShell(command, opts) {
  const args = opts.args;
  const allowedCodes = opts.allowedCodes || [0];
  const capturePath = opts.capturePath || "";
  const parseLine = typeof opts.parseLine === "function" ? opts.parseLine : () => {};
  const logOnSuccess = opts.logOnSuccess === true;
  const processGroup = opts.processGroup || null;
  const startedAt = Date.now();
    args.jobLog(`GPU Normalize Audio step: ${opts.label}`);
    return new Promise((resolve) => {
      const outputChunks = [];
      let lineBuffer = "";
    const capture = capturePath ? fs.createWriteStream(capturePath, { flags: "w" }) : null;
    const proc = childProcess.spawn("/bin/bash", ["-lc", command], { stdio: ["ignore", "pipe", "pipe"] });
    if (processGroup) {
      processGroup.procs.add(proc);
      if (processGroup.cancelled) {
        try { proc.kill("SIGTERM"); } catch (_) { /* noop */ }
      }
    }
    const exitHandler = () => {
      try { proc.kill("SIGTERM"); } catch (_) { /* noop */ }
    };
    process.once("exit", exitHandler);
      const handleData = (data) => {
        const text = String(data);
        if (capture) capture.write(text);
        outputChunks.push(text);
        while (outputChunks.join("").length > 100000) outputChunks.shift();
        if (args.logFullCliOutput === true) args.jobLog(text);
      lineBuffer += text.replace(/\r/g, "\n");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";
      lines.forEach(parseLine);
    };
    proc.stdout.on("data", handleData);
    proc.stderr.on("data", handleData);
    proc.on("error", (err) => {
      process.removeListener("exit", exitHandler);
      if (processGroup) processGroup.procs.delete(proc);
      if (capture) capture.end();
      args.jobLog(`Error running ${opts.label}: ${err.message}`);
      resolve({ code: 1, output: outputChunks.join(""), wallSec: (Date.now() - startedAt) / 1000 });
    });
    proc.on("close", (code) => {
      process.removeListener("exit", exitHandler);
      if (processGroup) processGroup.procs.delete(proc);
      if (lineBuffer) parseLine(lineBuffer);
      if (capture) capture.end();
      const output = outputChunks.join("");
      if (!allowedCodes.includes(code)) {
        args.jobLog(`${opts.label} exited with code ${code}`);
        const cleaned = cleanLogText(output).slice(-50000);
        if (cleaned) args.jobLog(cleaned);
      } else if (logOnSuccess && args.logFullCliOutput !== true) {
        const cleaned = cleanLogText(output).slice(-50000);
        if (cleaned) args.jobLog(cleaned);
      }
      resolve({ code, output, wallSec: (Date.now() - startedAt) / 1000 });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LOCK_HEARTBEAT_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = LOCK_HEARTBEAT_MS + 60 * 1000;

function maxConcurrentJobs(value) {
  const parsed = intNum(value, 1);
  if (parsed < 0) return 1;
  return Math.min(parsed, 32);
}

function holderPidForLock(dir) {
  try {
    const firstLine = fs.readFileSync(`${dir}/holder`, "utf8").split(/\r?\n/, 1)[0].trim();
    const pid = Number.parseInt(firstLine, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (_) {
    return null;
  }
}

function procStatusPpid(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^PPid:\s+(\d+)$/m);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch (_) {
    return null;
  }
}

function procCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch (_) {
    return "";
  }
}

function holderHasActiveNormalizeDescendant(holderPid) {
  try {
    const ppidByPid = new Map();
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number.parseInt(entry, 10);
      const ppid = procStatusPpid(pid);
      if (ppid !== null) ppidByPid.set(pid, ppid);
    }
    const isDescendant = (pid) => {
      let current = pid;
      for (let depth = 0; depth < 32; depth += 1) {
        const ppid = ppidByPid.get(current);
        if (ppid === holderPid) return true;
        if (!ppid || ppid === current) return false;
        current = ppid;
      }
      return false;
    };
    for (const pid of ppidByPid.keys()) {
      if (!isDescendant(pid)) continue;
      const cmdline = procCmdline(pid);
      if (cmdline.includes("tdarr-ffmpeg") || cmdline.includes("loudnorm") || cmdline.includes("gpu-normalize") || cmdline.includes("loudnorm-gpu-source-port")) return true;
    }
  } catch (_) {
    return false;
  }
  return false;
}

async function acquireConcurrencyLock(args, lockFileInput, maxConcurrentInput) {
  const maxConcurrent = maxConcurrentJobs(maxConcurrentInput);
  if (maxConcurrent === 0) {
    args.jobLog("GPU normalize guarded lock disabled: max_concurrent=0");
    return () => {};
  }
  const base = String(lockFileInput || "/tmp/opx_tdarr_gpu_normalize.lock").trim() || "/tmp/opx_tdarr_gpu_normalize.lock";
  const waitStartedAt = Date.now();
  let lastBusyLogAt = 0;
  while (true) {
    for (let slot = 1; slot <= maxConcurrent; slot += 1) {
      const dir = `${base}.slot${slot}.lockdir`;
      try {
        fs.mkdirSync(dir);
        const writeHeartbeat = () => {
          const stamp = `${process.pid}\n${new Date().toISOString()}\nslot=${slot}\nmax=${maxConcurrent}\n`;
          fs.writeFileSync(`${dir}/holder`, stamp);
          fs.writeFileSync(`${dir}/heartbeat`, stamp);
        };
        writeHeartbeat();
        const heartbeat = setInterval(() => {
          try {
            writeHeartbeat();
          } catch (err) {
            args.jobLog(`Failed to refresh GPU normalize slot ${slot}/${maxConcurrent}: ${err.message}`);
          }
        }, LOCK_HEARTBEAT_MS);
        if (heartbeat.unref) heartbeat.unref();
        args.jobLog(`Acquired GPU normalize slot ${slot}/${maxConcurrent}: ${dir}`);
        return () => {
          clearInterval(heartbeat);
          fs.rmSync(dir, { recursive: true, force: true });
          args.jobLog(`Released GPU normalize slot ${slot}/${maxConcurrent}: ${dir}`);
        };
      } catch (err) {
        if (!err || err.code !== "EEXIST") throw err;
        const heartbeatPath = `${dir}/heartbeat`;
        let stat;
        try {
          stat = fs.statSync(heartbeatPath);
        } catch (statErr) {
          if (statErr && statErr.code === "ENOENT") {
            try {
              stat = fs.statSync(`${dir}/holder`);
            } catch (holderErr) {
              if (holderErr && holderErr.code === "ENOENT") stat = fs.statSync(dir);
              else throw holderErr;
            }
          } else {
            throw statErr;
          }
        }
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > LOCK_STALE_MS) {
          const holderPid = holderPidForLock(dir);
          if (holderPid !== null && holderHasActiveNormalizeDescendant(holderPid)) {
            try {
              fs.copyFileSync(`${dir}/holder`, heartbeatPath);
            } catch (refreshErr) {
              args.jobLog(`Failed to refresh observed active GPU normalize slot ${slot}/${maxConcurrent}: ${refreshErr.message}`);
            }
            args.jobLog(`Preserving active GPU normalize slot ${slot}/${maxConcurrent}: ${dir} holder pid ${holderPid}`);
            continue;
          }
          args.jobLog(`Removing stale GPU normalize slot ${slot}/${maxConcurrent}: ${dir} heartbeat age ${Math.round(ageMs / 1000)}s`);
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    }
    const now = Date.now();
    if (lastBusyLogAt === 0 || now - lastBusyLogAt >= 60000) {
      args.jobLog(`All ${maxConcurrent} GPU normalize slots busy; checking every 10s (waited ${Math.round((now - waitStartedAt) / 1000)}s): ${base}.slotN.lockdir`);
      lastBusyLogAt = now;
    }
    await sleep(10000);
  }
}

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
    { label: "Add Generated 2-Channel Track", name: "ensureStereo", type: "boolean", defaultValue: true, inputUI: { type: "checkbox" }, tooltip: "Default on. Adds generated normalized stereo according to the selected 2-channel scope." },
    { label: "Only Generate 2-Channel For First Language", name: "stereoFallbackFirstOnly", type: "boolean", defaultValue: true, inputUI: { type: "checkbox" }, tooltip: "Default on. Ensure the first language selected by Track Order has 2-channel audio; if that language lacks stereo, create one generated track, preferring a 5.1/6-channel source over 7.1/8-channel. Disable to create generated stereo for every non-stereo audio stream." },
    { label: "Max Concurrent Jobs", name: "maxConcurrentJobs", type: "string", defaultValue: "1", inputUI: { type: "text" }, tooltip: "Maximum concurrent GPU normalize jobs for this lock base. Set 0 to disable the guarded slot lock." },
    { label: "Audio Bitrate", name: "audioBitrate", type: "string", defaultValue: "192k", inputUI: { type: "text" }, tooltip: "AAC bitrate for normalized audio streams. Only 192k is covered by the release parity/performance matrix." },
    { label: "Integrated Loudness I", name: "i", type: "string", defaultValue: "-18.0", inputUI: { type: "text" }, tooltip: "FFmpeg loudnorm I target in LUFS." },
    { label: "Loudness Range LRA", name: "lra", type: "string", defaultValue: "7.0", inputUI: { type: "text" }, tooltip: "FFmpeg loudnorm LRA target in LU." },
    { label: "True Peak TP", name: "tp", type: "string", defaultValue: "-2.0", inputUI: { type: "text" }, tooltip: "FFmpeg loudnorm true-peak target in dBTP." },
    { label: "Max Gain dB", name: "maxGain", type: "string", defaultValue: "15", inputUI: { type: "text" }, tooltip: "Safety gate. If target loudness needs more gain than this, copy the original package instead of normalizing. Use 0 to disable." },
    { label: "Debug Logging", name: "debugLogging", type: "boolean", defaultValue: false, inputUI: { type: "checkbox" }, tooltip: "Default off. Enables full successful FFmpeg/runtime output in job logs for troubleshooting." },
  ],
  outputs: [
    { number: 1, tooltip: "Normalized audio streams muxed back into the original package" },
  ],
});
exports.details = details;

const plugin = async (args) => {
  const pluginStartedAt = Date.now();
  const lib = loadTdarrLib();
  const { getContainer, getFileName, getPluginWorkDir } = loadFlowHelpers();
  args.inputs = loadInputsPreservingExplicitBlanks(lib, args.inputs);
  const debugLogging = boolInput(args.inputs.debugLogging, false) || args.logFullCliOutput === true;
  args.logFullCliOutput = debugLogging;

  const streams = (((args.inputFileObj || {}).ffProbeData || {}).streams || []);
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
  const requireGpuWorker = boolInput(args.inputs.requireGpuWorker, true);
  const workerType = String(args.workerType || "").trim().toLowerCase();
  if (requireGpuWorker && workerType && workerType !== "transcodegpu") {
    throw new Error(`GPU Normalize Audio must run on a Transcode GPU worker; Tdarr scheduled workerType=${workerType}. Add a Worker Type gate or disable Transcode CPU workers for this flow.`);
  }
  if (audioStreams.length === 0) {
    args.jobLog("No audio streams found; skipping GPU normalize.");
    return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
  }

  const plannerMode = String(args.inputs.plannerMode || "gpuSourcePort").trim();
  const useGpuSourcePort = plannerMode === "gpuSourcePort";
  const sourceCorePath = String(args.inputs.sourceCorePath || `${RUNTIME_BIN}/loudnorm-source-cpu`).trim();
  const gpuPlanCorePath = String(args.inputs.gpuPlanCorePath || `${RUNTIME_BIN}/loudnorm-gpu-source-port`).trim();
  const gpuApplyPath = String(args.inputs.gpuApplyPath || `${RUNTIME_BIN}/gpu-apply-sample-gains`).trim();
  const pythonPath = String(process.env.PYTHON || "python3").trim() || "python3";
  const gpuPlanCoreCommand = () => {
    ensureReadableRuntime("GPU plan core", gpuPlanCorePath);
    return [q(pythonPath), q(gpuPlanCorePath)];
  };
  const defaultChunkMiB = "1";
  const stereoFallbackChunkMiB = String(process.env.LOUDNORM_GPU_STEREO_FALLBACK_CHUNK_MIB || "").trim();
  const stereoFallbackApplyChunkMiB = String(process.env.LOUDNORM_GPU_STEREO_FALLBACK_APPLY_CHUNK_MIB || "").trim();
  if (useGpuSourcePort) {
    ensureReadableRuntime("GPU plan core", gpuPlanCorePath);
  } else {
    ensureExecutableRuntime("Source core", sourceCorePath);
    ensureExecutableRuntime("GPU apply", gpuApplyPath);
  }

  const sampleRate = intNum(args.inputs.sampleRate, 192000);
  const encodeSampleRateInput = String(args.inputs.encodeSampleRate || "").trim();
  const forcedEncodeSampleRate = encodeSampleRateInput ? intNum(encodeSampleRateInput, sampleRate) : 0;
  const targetI = num(args.inputs.i, -18.0);
  const targetLra = num(args.inputs.lra, 7.0);
  const targetTp = num(args.inputs.tp, -2.0);
  const maxGain = num(args.inputs.maxGain, 15);
  const ensureStereo = boolInput(args.inputs.ensureStereo, true);
  const stereoFallbackFirstOnly = boolInput(args.inputs.stereoFallbackFirstOnly, true);
  const stereoLanguageOrder = stereoFallbackLanguageOrder(args.inputs.stereoFallbackOrder);
  const normalizeOnlyLanguages = normalizeOnlyLanguageOrder(args.inputs.normalizeOnlyLanguages);
  const audioBitrate = String(args.inputs.audioBitrate || "192k").replace(/[^0-9kKmM]/g, "") || "192k";
  const gpuInputFormat = useGpuSourcePort ? "f64le" : "f32le";
  const gpuInputExt = useGpuSourcePort ? "f64" : "f32";
  const gpuOutputFormat = useGpuSourcePort ? "f64le" : "f32le";
  const gpuOutputExt = useGpuSourcePort ? "f64" : "f32";
  const useStreamingSourcePort = useGpuSourcePort;
  const container = getContainer(args.inputFileObj._id);
  const workDir = getPluginWorkDir(args);
  const base = getFileName(args.inputFileObj._id);
  const runId = `${process.pid}-${Date.now()}`;
  const outputFilePath = `${workDir}/${base}.${container}`;
  const tmpOutputFilePath = `${workDir}/${base}.tmp-${runId}.${container}`;
  if (outputFilePath === args.inputFileObj._id) throw new Error(`GPU normalize output path equals input path: ${outputFilePath}`);
  const copyOriginal = [
    q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", q(args.inputFileObj._id),
    "-map", "0", "-map_chapters", "0", "-map_metadata", "0", "-c", "copy", q(tmpOutputFilePath),
  ].join(" ");

  const allSourceAudioPlans = audioStreams.map((stream, idx) => {
    const streamChannels = channelCount(args.inputs.channels, stream, 2);
    const suffix = `a${idx}`;
    return {
      idx,
      sourceIdx: idx,
      channels: streamChannels,
      channelLayout: sourceChannelLayout(stream, streamChannels),
      sourceSampleRate: intNum(stream.sample_rate, 0),
      language: langTag((stream.tags || {}).language || stream.language || "und"),
      stereoFallback: false,
      sourceInput: args.inputFileObj._id,
      sourceAudioIdx: idx,
      rawInput: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.input.${gpuInputExt}`,
      rawInputFormat: gpuInputFormat,
      gains: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.gains.f32`,
      statsCache: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.stats.bin`,
      measureErr: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.measure.err`,
      statsErr: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.stats.err`,
      sourceErr: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.source.err`,
      rawGpu: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.output.${gpuOutputExt}`,
      rawGpuFormat: gpuOutputFormat,
      normalizedAudio: `${workDir}/${base}.gpu-normalized.${suffix}.${runId}.m4a`,
      fifoInput: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.stream-in.fifo`,
      fifoOutput: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.stream-out.fifo`,
    };
  });
  const sortedSourceAudioPlans = sortAudioPlansByLanguage(allSourceAudioPlans, stereoLanguageOrder);
  const normalizeOnlyLanguageSet = new Set(normalizeOnlyLanguages);
  let audioPlans = normalizeOnlyLanguages.length > 0
    ? sortedSourceAudioPlans.filter((plan) => normalizeOnlyLanguageSet.has(stereoFallbackLanguageKey(plan)))
    : sortedSourceAudioPlans.slice();
  const selectedLanguageKeys = Array.from(new Set(audioPlans.filter((plan) => !plan.stereoFallback).map(stereoFallbackLanguageKey)));
  const normalizedSourceKeys = new Set(audioPlans.filter((plan) => !plan.stereoFallback).map((plan) => plan.sourceIdx));
  const skippedAudioPlans = sortedSourceAudioPlans.filter((plan) => !normalizedSourceKeys.has(plan.sourceIdx));
  let nextPlanIdx = Math.max(0, ...audioPlans.map((plan) => plan.idx)) + 1;
  const makeStereoFallbackPlan = (sourceIdx, fallbackOrdinal) => {
    const stream = audioStreams[sourceIdx];
    const suffix = sourceIdx === 0 && fallbackOrdinal === 0 ? "stereo" : `stereo.a${sourceIdx}`;
    return {
      idx: nextPlanIdx++,
      sourceIdx,
      channels: 2,
      channelLayout: "stereo",
      sourceSampleRate: intNum(stream.sample_rate, 0),
      language: langTag((stream.tags || {}).language || stream.language || "und"),
      stereoFallback: true,
      sourceInput: args.inputFileObj._id,
      sourceAudioIdx: sourceIdx,
      rawInput: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.input.${gpuInputExt}`,
      rawInputFormat: gpuInputFormat,
      gains: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.gains.f32`,
      statsCache: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.stats.bin`,
      measureErr: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.measure.err`,
      statsErr: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.stats.err`,
      sourceErr: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.source.err`,
      rawGpu: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.output.${gpuOutputExt}`,
      rawGpuFormat: gpuOutputFormat,
      normalizedAudio: `${workDir}/${base}.gpu-normalized.${suffix}.${runId}.m4a`,
      fifoInput: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.stream-in.fifo`,
      fifoOutput: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.stream-out.fifo`,
    };
  };
  if (ensureStereo) {
    const sourcePlans = selectStereoFallbackSourcePlans(audioPlans, stereoFallbackFirstOnly);
    let fallbackOrdinal = 0;
    for (const sourcePlan of sourcePlans) {
      audioPlans.push(makeStereoFallbackPlan(sourcePlan.sourceIdx, fallbackOrdinal));
      fallbackOrdinal += 1;
    }
  }
  const describePlan = (plan) => {
    const source = allSourceAudioPlans[plan.sourceIdx];
    const sourceText = source ? `#${source.sourceIdx} ${source.language} ${source.channels}ch` : `#${plan.sourceIdx}`;
    if (plan.stereoFallback) return `create normalized stereo from ${sourceText}`;
    return `normalize ${sourceText}`;
  };
  const describeCopy = (plan) => `copy #${plan.sourceIdx} ${plan.language} ${plan.channels}ch unchanged`;
  const logDebugPlanSummary = () => {
    if (!debugLogging) return;
    args.jobLog(`GPU normalize audio streams: normalize_scope=${normalizeOnlyLanguages.length > 0 ? "only_languages" : "all"} normalize_only_languages=${normalizeOnlyLanguages.join(",") || "all"} selected_languages=${selectedLanguageKeys.join(",") || (normalizeOnlyLanguages.length > 0 ? "none" : "all")} normalized_count=${audioPlans.length} copied_audio_count=${skippedAudioPlans.length} channel_input=${String(args.inputs.channels || "auto")} effective_channels=${audioPlans.map((plan) => plan.channels).join(",") || "none"} ensure_stereo=${ensureStereo ? "true" : "false"} stereo_scope=${ensureStereo ? (stereoFallbackFirstOnly ? "first_language" : "all_non_stereo_audio") : "off"} stereo_language_order=${stereoLanguageOrder.join(",") || "source"}`);
    if (skippedAudioPlans.length > 0) args.jobLog(`GPU normalize copied original audio streams unchanged: ${skippedAudioPlans.map((plan) => `${plan.sourceIdx}:${plan.language}`).join(",")}`);
  };
  const inputAudioSummary = audioStreams.map(streamSummary).join("; ");
  const normalizeScopeText = normalizeOnlyLanguages.length > 0 ? `only ${normalizeOnlyLanguages.join(", ")}` : "all audio languages";
  const stereoPlanText = ensureStereo
    ? `ensure stereo for ${stereoFallbackFirstOnly ? "first selected language" : "each selected non-stereo stream"}`
    : "do not add generated stereo";
  args.jobLog(`GPU Normalize Audio input audio: ${inputAudioSummary}`);
  args.jobLog(`GPU Normalize Audio settings: normalize ${normalizeScopeText}; ${stereoPlanText}; track order ${stereoLanguageOrder.join(", ") || "source order"}`);
  if (audioPlans.length === 0) {
    args.jobLog(`GPU Normalize Audio plan: no audio stream matches ${normalizeOnlyLanguages.join(", ") || "the selected languages"}; all audio will stay unchanged.`);
    logDebugPlanSummary();
    args.jobLog("GPU Normalize Audio result: no GPU work, no mux, file passed through unchanged.");
    if (typeof args.updateWorker === "function") args.updateWorker({ percentage: 100, ETA: "0:00:00" });
    return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
  }
  args.jobLog(`GPU Normalize Audio plan: ${audioPlans.map(describePlan).join("; ")}${skippedAudioPlans.length > 0 ? `; ${skippedAudioPlans.map(describeCopy).join("; ")}` : ""}.`);
  const durationSeconds = parseDurationSeconds(args.inputFileObj) || 1;
  const statsCachePathFor = (plan, statsSampleRate) => statsSampleRate === sampleRate
    ? plan.statsCache
    : plan.statsCache.replace(/\.stats\.bin$/, `.r${statsSampleRate}.stats.bin`);
  const statsErrPathFor = (plan, statsSampleRate) => statsSampleRate === sampleRate
    ? plan.statsErr
    : plan.statsErr.replace(/\.stats\.err$/, `.r${statsSampleRate}.stats.err`);
  const trackStatsPaths = (plan, statsSampleRate) => {
    const statsCache = statsCachePathFor(plan, statsSampleRate);
    const statsErr = statsErrPathFor(plan, statsSampleRate);
    if (!plan.statsCaches.includes(statsCache)) plan.statsCaches.push(statsCache);
    if (!plan.statsErrs.includes(statsErr)) plan.statsErrs.push(statsErr);
    return { statsCache, statsErr };
  };
  for (const plan of audioPlans) {
    plan.statsCaches = [plan.statsCache];
    plan.statsErrs = [plan.statsErr];
    if (plan.sourceSampleRate > 0 && plan.sourceSampleRate !== sampleRate) trackStatsPaths(plan, plan.sourceSampleRate);
    plan.work = Math.max(1, durationSeconds * plan.channels);
    plan.estimatedRawInputBytes = Math.ceil(durationSeconds * sampleRate * plan.channels * sampleBytes(plan.rawInputFormat));
    plan.estimatedRawOutputBytes = Math.ceil(durationSeconds * sampleRate * plan.channels * sampleBytes(plan.rawGpuFormat));
  }
  const audioWork = audioPlans.reduce((sum, plan) => sum + plan.work, 0);
  const muxWork = Math.max(1, audioWork * 0.03);
  const totalWork = audioWork + muxWork;
  const baselineEtaSeconds = Math.max(5, totalWork / 90);
  const updateProgress = createProgressUpdater(args, totalWork, baselineEtaSeconds);
  const cleanupFilesForPlan = (plan) => [plan.rawInput, plan.gains, ...(plan.statsCaches || [plan.statsCache]), plan.measureErr, ...(plan.statsErrs || [plan.statsErr]), plan.sourceErr, plan.rawGpu, plan.normalizedAudio, plan.fifoInput, plan.fifoOutput, `${plan.fifoInput}.stats`, `${plan.fifoOutput}.stats`];
  const allIntermediateFiles = audioPlans.flatMap(cleanupFilesForPlan);
  const cleanupAll = `rm -f ${[...allIntermediateFiles, tmpOutputFilePath].map(q).join(" ")}`;

  const muxArgs = [q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", q(args.inputFileObj._id)];
  for (const plan of audioPlans) muxArgs.push("-i", q(plan.normalizedAudio));
  muxArgs.push("-map", "0:v?");
  audioPlans.forEach((_, idx) => muxArgs.push("-map", `${idx + 1}:a:0`));
  skippedAudioPlans.forEach((plan) => muxArgs.push("-map", `0:a:${plan.sourceAudioIdx}`));
  muxArgs.push("-map", "0:s?", "-map", "0:t?", "-map", "0:d?", "-map_chapters", "0", "-map_metadata", "0", "-c", "copy");
  let muxAudioIdx = 0;
  audioPlans.forEach((plan) => {
    muxArgs.push(`-metadata:s:a:${muxAudioIdx}`, q(`language=${plan.language}`));
    muxAudioIdx += 1;
  });
  skippedAudioPlans.forEach((plan) => {
    muxArgs.push(`-metadata:s:a:${muxAudioIdx}`, q(`language=${plan.language}`));
    muxAudioIdx += 1;
  });
  muxArgs.push(q(tmpOutputFilePath));
  const mux = muxArgs.join(" ");

  const runChecked = async (command, opts) => {
    const res = await runShell(command, { args, ...opts });
    if (!(opts.allowedCodes || [0]).includes(res.code)) throw new Error(`${opts.label} failed`);
    return res;
  };
  const nsysRuntimeProfile = envFlag("LOUDNORM_GPU_NSYS");
  const nsysTrace = String(process.env.LOUDNORM_GPU_NSYS_TRACE || "cuda,osrt,nvtx").trim() || "cuda,osrt,nvtx";
  const nsysSample = normalizeNsysSample(process.env.LOUDNORM_GPU_NSYS_SAMPLE || "none");
  const nsysOutputDir = String(process.env.LOUDNORM_GPU_NSYS_OUTPUT_DIR || workDir).trim() || workDir;
  const wrapRuntimeProfile = (command, plan, label) => {
    if (!nsysRuntimeProfile) return command;
    const profileBase = `${nsysOutputDir}/${base}.gpu-normalize.${runId}.${label}.stream${plan.idx}`.replace(/[^A-Za-z0-9_./-]/g, "_");
    args.jobLog(`GPU normalize Nsight Systems profile enabled for ${planLabelFor(plan)}: ${profileBase}.nsys-rep`);
    return [
      "mkdir", "-p", q(nsysOutputDir), "&&",
      "nsys", "profile",
      "--force-overwrite=true",
      "--export=sqlite",
      `--trace=${q(nsysTrace)}`,
      `--sample=${q(nsysSample)}`,
      `--output=${q(profileBase)}`,
      command,
    ].join(" ");
  };
  const cpuLoudnormResults = new Map();
  const cpuLoudnormTasks = new Map();
  const splitStatsTasks = new Map();
  const splitStatsResults = new Map();
  const backgroundCpuGroup = { procs: new Set(), cancelled: false };

  const planLabelFor = (plan) => `audio stream ${plan.sourceIdx}${plan.stereoFallback ? " stereo fallback" : ""}`;
  const sourceChannelsFor = (plan) => primaryAudioChannels(audioStreams[plan.sourceIdx], plan.channels);
  const needsInlineStereoDownmix = (plan) => plan.channels === 2 && sourceChannelsFor(plan) !== 2;
  const stereoFallbackSourceExact = envFlag("LOUDNORM_GPU_STEREO_FALLBACK_SOURCE_EXACT", true);
  const usesStereoFallbackSourcePath = (plan) => stereoFallbackSourceExact && plan.stereoFallback && needsInlineStereoDownmix(plan);
  const cpuLoudnormKey = (plan) => `${plan.sourceIdx}:${plan.channels}`;
  const loudnormFilter = () => `loudnorm=I=${targetI}:LRA=${targetLra}:TP=${targetTp}:print_format=json`;
  const loudnessSummary = (values) => `input ${loudnormNumber(values, "input_i").toFixed(2)} LUFS, true peak ${loudnormNumber(values, "input_tp").toFixed(2)} dBTP, target offset ${loudnormNumber(values, "target_offset").toFixed(2)} dB`;
  const pairCpuLoudnormMeasure = envFlag("LOUDNORM_GPU_PAIR_CPU_LOUDNORM_MEASURE", false);
  const gpuFirstPassMeasure = useGpuSourcePort && useStreamingSourcePort && args.platform !== "win32" && envFlag("LOUDNORM_GPU_FIRST_PASS_MEASURE");
  const gpuFirstPassAudit = useGpuSourcePort && useStreamingSourcePort && args.platform !== "win32" && !gpuFirstPassMeasure && envFlag("LOUDNORM_GPU_FIRST_PASS_AUDIT");
  const cpuLoudnormFilter = (plan) => {
    const loudnorm = loudnormFilter();
    if (needsInlineStereoDownmix(plan)) return `aformat=channel_layouts=stereo,${loudnorm}`;
    return loudnorm;
  };
  const ffmpegLinearMode = (values) => {
    if (!values) return false;
    if (values._gpuFirstPass && envFlag("LOUDNORM_GPU_FIRST_PASS_FORCE_DYNAMIC", true)) return false;
    if (envFlag("LOUDNORM_GPU_FORCE_LINEAR_MODE")) return true;
    const measuredI = loudnormNumber(values, "input_i");
    const measuredLra = loudnormNumber(values, "input_lra");
    const measuredTp = loudnormNumber(values, "input_tp");
    const measuredThresh = loudnormNumber(values, "input_thresh");
    const linearOffset = targetI - measuredI;
    return measuredTp !== 99.0
      && measuredThresh !== -70.0
      && measuredLra !== 0.0
      && measuredI !== 0.0
      && measuredTp + linearOffset <= targetTp
      && measuredLra <= targetLra;
  };
  const processingSampleRateFor = (plan, values) => {
    const stereoFallbackSampleRate = Math.max(0, intNum(process.env.LOUDNORM_GPU_STEREO_FALLBACK_SAMPLE_RATE, 0));
    const originalSampleRate = Math.max(0, intNum(process.env.LOUDNORM_GPU_ORIGINAL_SAMPLE_RATE, 0));
    if (plan.stereoFallback && stereoFallbackSampleRate > 0) return stereoFallbackSampleRate;
    if (!plan.stereoFallback && originalSampleRate > 0) return originalSampleRate;
    if (!plan.stereoFallback && plan.sourceSampleRate > 0 && envFlag("LOUDNORM_GPU_ORIGINAL_SOURCE_SAMPLE_RATE")) return plan.sourceSampleRate;
    if (!plan.stereoFallback && plan.sourceSampleRate > 0 && ffmpegLinearMode(values)) return plan.sourceSampleRate;
    return sampleRate;
  };
  const encodeSampleRateArgsFor = (plan, values) => {
    if (forcedEncodeSampleRate > 0) return ["-ar", String(forcedEncodeSampleRate)];
    const originalSampleRate = Math.max(0, intNum(process.env.LOUDNORM_GPU_ORIGINAL_SAMPLE_RATE, 0));
    if (!plan.stereoFallback && originalSampleRate > 0) return ["-ar", String(originalSampleRate)];
    if (!plan.stereoFallback && plan.sourceSampleRate > 0 && envFlag("LOUDNORM_GPU_ORIGINAL_SOURCE_SAMPLE_RATE")) return ["-ar", String(plan.sourceSampleRate)];
    if (!plan.stereoFallback && plan.sourceSampleRate > 0 && ffmpegLinearMode(values)) return ["-ar", String(plan.sourceSampleRate)];
    return [];
  };
  const decodeAudioArgs = (plan) => {
    if (needsInlineStereoDownmix(plan)) return ["-af", "aformat=channel_layouts=stereo"];
    if (plan.channelLayout) return ["-af", `aformat=channel_layouts=${plan.channelLayout}`];
    return ["-ac", String(plan.channels)];
  };
  const rawInputAudioArgs = (plan, values) => [
    "-ac", String(plan.channels),
    ...(plan.channelLayout ? ["-channel_layout", plan.channelLayout] : []),
    "-ar", String(processingSampleRateFor(plan, values)),
  ];
  const chunkMiBFor = (plan) => (plan.stereoFallback && stereoFallbackChunkMiB ? stereoFallbackChunkMiB : defaultChunkMiB);
  const applyChunkMiBFor = (plan) => (plan.stereoFallback && stereoFallbackApplyChunkMiB ? stereoFallbackApplyChunkMiB : chunkMiBFor(plan));
  const buildCpuLoudnormMeasure = (plan) => [
    q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", q(plan.sourceInput),
    "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn",
    "-af", q(cpuLoudnormFilter(plan)),
    "-f", "null", (args.platform === "win32" ? "NUL" : "/dev/null"),
  ].join(" ");

  const pairedCpuLoudnormPartner = (plan) => {
    if (!pairCpuLoudnormMeasure || !useGpuSourcePort || args.platform === "win32") return null;
    if (plan.stereoFallback && needsInlineStereoDownmix(plan)) {
      return audioPlans.find((candidate) => !candidate.stereoFallback && candidate.sourceIdx === plan.sourceIdx) || null;
    }
    return audioPlans.find((candidate) => candidate.stereoFallback && candidate.sourceIdx === plan.sourceIdx && needsInlineStereoDownmix(candidate)) || null;
  };

  const buildPairedCpuLoudnormMeasure = (plan, partner) => {
    const originalPlan = plan.stereoFallback ? partner : plan;
    const stereoPlan = plan.stereoFallback ? plan : partner;
    const filterGraph = `[0:a:${originalPlan.sourceAudioIdx}]asplit=2[orig_in][stereo_in];[orig_in]${loudnormFilter()}[orig_out];[stereo_in]aformat=channel_layouts=stereo,${loudnormFilter()}[stereo_out]`;
    return [
      q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", q(originalPlan.sourceInput),
      "-filter_complex", q(filterGraph),
      "-map", "[orig_out]", "-f", "null", (args.platform === "win32" ? "NUL" : "/dev/null"),
      "-map", "[stereo_out]", "-f", "null", (args.platform === "win32" ? "NUL" : "/dev/null"),
    ].join(" ");
  };

  const gpuFirstPassStatsPathFor = (plan, statsSampleRate) => statsCachePathFor(plan, statsSampleRate).replace(/\.stats\.bin$/, ".first-pass.stats.bin");
  const buildGpuFirstPassMeasure = (plan, statsSampleRate, statsCache, writeStatsCache) => {
    const decodeCommand = [
      String(args.ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", String(plan.sourceInput),
      "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...decodeAudioArgs(plan), "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, "pipe:1",
    ];
    const encodeCommand = ["sh", "-lc", "cat >/dev/null"];
    return [
      ...gpuPlanCoreCommand(), "-", "-",
      "--rate", String(statsSampleRate), "--channels", String(plan.channels),
      "--target-i", String(targetI), "--target-lra", String(targetLra), "--target-tp", String(targetTp),
      "--max-gain-db", String(maxGain), "--chunk-mib", q(applyChunkMiBFor(plan)),
      "--measured-i", "0", "--measured-lra", "0", "--measured-tp", "99", "--measured-thresh", "-70",
      "--offset-db", "0", "--ffmpeg-linear", "--disable-short-source-exact", "--ffmpeg-limiter", "--ffmpeg-gain-offset-ms", "210",
      "--input-format", q(plan.rawInputFormat),
      "--output-format", q(plan.rawGpuFormat),
      "--ptx-path", q(`${RUNTIME_CUDA}/loudnorm_source_port_kernels.ptx`), "--source-core-path", q(sourceCorePath),
      "--streaming-io", "--parallel-final-apply", "--expected-seconds", String(Math.max(1, durationSeconds)),
      "--decode-command-json", q(JSON.stringify(decodeCommand)),
      "--encode-command-json", q(JSON.stringify(encodeCommand)),
      "--emit-first-pass-json",
      ...(writeStatsCache ? ["--stats-cache-output", q(statsCache)] : []),
      ...(usesStereoFallbackSourcePath(plan) ? ["--stereo-fallback-source-exact"] : []),
    ].join(" ");
  };

  const compareGpuFirstPassValues = (planLabel, cpuValues, gpuValues) => {
    const keys = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"];
    const diffs = keys.map((key) => `${key}=${(loudnormNumber(gpuValues, key) - loudnormNumber(cpuValues, key)).toFixed(4)}`);
    args.jobLog(`GPU normalize first-pass audit ${planLabel}: gpu=${JSON.stringify(gpuValues)} diff_vs_cpu ${diffs.join(" ")}`);
  };

  const runGpuFirstPassMeasure = async (plan, opts = {}) => {
    const background = opts.background === true;
    const writeStatsCache = opts.writeStatsCache === true;
    const planLabel = planLabelFor(plan);
    const statsSampleRate = processingSampleRateFor(plan, null);
    const statsCache = writeStatsCache ? gpuFirstPassStatsPathFor(plan, statsSampleRate) : "";
    if (writeStatsCache) {
      if (!plan.statsCaches.includes(statsCache)) plan.statsCaches.push(statsCache);
    }
    const startedAt = Date.now();
    const measureRes = await runChecked(wrapRuntimeProfile(buildGpuFirstPassMeasure(plan, statsSampleRate, statsCache, writeStatsCache), plan, "first-pass"), {
      label: `${background ? "prefetch " : ""}GPU loudnorm first pass ${planLabel}`,
      capturePath: plan.measureErr,
      logOnSuccess: debugLogging && !background,
      processGroup: background ? backgroundCpuGroup : null,
      parseLine: background ? undefined : opts.parseLine,
    });
    const values = parseLoudnormJson(measureRes.output);
    for (const loudnormKey of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) loudnormNumber(values, loudnormKey);
    values._gpuFirstPass = true;
    return {
      values,
      wallSec: measureRes.wallSec,
      source: writeStatsCache ? "gpu_first_pass" : "gpu_first_pass_audit",
      background,
      queuedSec: (startedAt - (opts.queuedAt || startedAt)) / 1000,
      statsSampleRate,
      statsCache: writeStatsCache ? statsCache : "",
    };
  };

  const startCpuLoudnormTask = (plan, opts = {}) => {
    const key = cpuLoudnormKey(plan);
    const existingResult = cpuLoudnormResults.get(key);
    if (existingResult) return Promise.resolve(existingResult);
    const existingTask = cpuLoudnormTasks.get(key);
    if (existingTask) return existingTask;
    const background = opts.background === true;
    const planLabel = planLabelFor(plan);
    const queuedAt = Date.now();
    if (gpuFirstPassMeasure) {
      const task = runGpuFirstPassMeasure(plan, { ...opts, queuedAt, writeStatsCache: true }).then((result) => {
        cpuLoudnormResults.set(key, result);
        if (!background) args.jobLog(`GPU Normalize Audio result: measured ${planLabel}: ${loudnessSummary(result.values)}.`);
        else if (debugLogging) args.jobLog(`GPU normalize GPU loudnorm first pass ${planLabel} prefetched: ${JSON.stringify(result.values)}`);
        return result;
      });
      if (background) {
        task.catch((err) => {
          if (!backgroundCpuGroup.cancelled) args.jobLog(`GPU normalize GPU loudnorm prefetch failed for ${planLabel}: ${err.message}`);
        });
      }
      cpuLoudnormTasks.set(key, task);
      return task;
    }
    const partner = pairedCpuLoudnormPartner(plan);
    if (partner) {
      const partnerKey = cpuLoudnormKey(partner);
      const partnerExistingResult = cpuLoudnormResults.get(partnerKey);
      const partnerExistingTask = cpuLoudnormTasks.get(partnerKey);
      if (!partnerExistingResult && !partnerExistingTask) {
        const originalPlan = plan.stereoFallback ? partner : plan;
        const stereoPlan = plan.stereoFallback ? plan : partner;
        const originalKey = cpuLoudnormKey(originalPlan);
        const stereoKey = cpuLoudnormKey(stereoPlan);
        const pairTask = (async () => {
          const startedAt = Date.now();
          const measureRes = await runChecked(buildPairedCpuLoudnormMeasure(plan, partner), {
            label: `${background ? "prefetch " : ""}paired CPU loudnorm first pass ${planLabelFor(originalPlan)} + ${planLabelFor(stereoPlan)}`,
            capturePath: plan.measureErr,
            logOnSuccess: debugLogging && !background,
            processGroup: background ? backgroundCpuGroup : null,
            parseLine: background ? undefined : opts.parseLine,
          });
          const blocks = parseLoudnormJsonBlocks(measureRes.output);
          if (blocks.length < 2) throw new Error("GPU normalize: paired CPU loudnorm did not produce two JSON blocks");
          const originalValues = blocks[0];
          const stereoValues = blocks[1];
          for (const values of [originalValues, stereoValues]) {
            for (const loudnormKey of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) loudnormNumber(values, loudnormKey);
          }
          const baseResult = {
            wallSec: measureRes.wallSec,
            source: background ? "paired_prefetched" : "paired_measured",
            background,
            queuedSec: (startedAt - queuedAt) / 1000,
          };
          const originalResult = { ...baseResult, values: originalValues };
          const stereoResult = { ...baseResult, values: stereoValues };
          cpuLoudnormResults.set(originalKey, originalResult);
          cpuLoudnormResults.set(stereoKey, stereoResult);
          if (!background) {
            args.jobLog(`GPU Normalize Audio result: measured ${planLabelFor(originalPlan)}: ${loudnessSummary(originalValues)}.`);
            args.jobLog(`GPU Normalize Audio result: measured ${planLabelFor(stereoPlan)}: ${loudnessSummary(stereoValues)}.`);
          } else if (debugLogging) {
            args.jobLog(`GPU normalize paired CPU loudnorm first pass ${planLabelFor(originalPlan)}: ${JSON.stringify(originalValues)}`);
            args.jobLog(`GPU normalize paired CPU loudnorm first pass ${planLabelFor(stereoPlan)}: ${JSON.stringify(stereoValues)}`);
          }
          return new Map([[originalKey, originalResult], [stereoKey, stereoResult]]);
        })();
        const currentTask = pairTask.then((results) => results.get(key));
        const partnerTask = pairTask.then((results) => results.get(partnerKey));
        cpuLoudnormTasks.set(key, currentTask);
        cpuLoudnormTasks.set(partnerKey, partnerTask);
        return currentTask;
      }
    }
    const task = (async () => {
      const startedAt = Date.now();
      const measureRes = await runChecked(buildCpuLoudnormMeasure(plan), {
        label: `${background ? "prefetch " : ""}CPU loudnorm first pass ${planLabel}`,
        capturePath: plan.measureErr,
        logOnSuccess: debugLogging && !background,
        processGroup: background ? backgroundCpuGroup : null,
        parseLine: background ? undefined : opts.parseLine,
      });
      const values = parseLoudnormJson(measureRes.output);
      for (const loudnormKey of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) loudnormNumber(values, loudnormKey);
      if (gpuFirstPassAudit && !background) {
        const gpuAudit = await runGpuFirstPassMeasure(plan, { writeStatsCache: false });
        compareGpuFirstPassValues(planLabel, values, gpuAudit.values);
      }
      const result = {
        values,
        wallSec: measureRes.wallSec,
        source: background ? "prefetched" : "measured",
        background,
        queuedSec: (startedAt - queuedAt) / 1000,
      };
      cpuLoudnormResults.set(key, result);
      if (!background) args.jobLog(`GPU Normalize Audio result: measured ${planLabel}: ${loudnessSummary(values)}.`);
      else if (debugLogging) args.jobLog(`GPU normalize CPU loudnorm first pass ${planLabel} prefetched: ${JSON.stringify(values)}`);
      return result;
    })();
    if (background) {
      task.catch((err) => {
        if (!backgroundCpuGroup.cancelled) args.jobLog(`GPU normalize CPU loudnorm prefetch failed for ${planLabel}: ${err.message}`);
      });
    }
    cpuLoudnormTasks.set(key, task);
    return task;
  };

  const getCpuLoudnormRecord = async (plan, parseLine) => {
    const key = cpuLoudnormKey(plan);
    const externalCached = (!gpuFirstPassMeasure && sourceChannelsFor(plan) === plan.channels) ? cachedCpuLoudnorm(args, plan.sourceIdx) : null;
    if (externalCached) {
      const result = { values: externalCached, wallSec: 0, source: "external_cached", waitSec: 0, queuedSec: 0, background: false };
      cpuLoudnormResults.set(key, result);
      return result;
    }
    const existingResult = cpuLoudnormResults.get(key);
    if (existingResult) return { ...existingResult, reused: true, waitSec: 0 };
    const existingTask = cpuLoudnormTasks.get(key);
    const task = existingTask || startCpuLoudnormTask(plan, { parseLine });
    const waitStartedAt = Date.now();
    const result = await task;
    const waitSec = (Date.now() - waitStartedAt) / 1000;
    const effectiveWaitSec = result.source === "fused_split_stats" ? 0 : waitSec;
    return (existingTask || result.source === "prefetched") ? { ...result, reused: true, waitSec: effectiveWaitSec } : { ...result, waitSec: effectiveWaitSec };
  };

  const fallbackPlans = audioPlans.filter((plan) => plan.stereoFallback);
  const fallbackFirst = envFlag("LOUDNORM_GPU_FALLBACK_FIRST", true);
  const earlyCpuPrefetch = !gpuFirstPassMeasure && envFlag("LOUDNORM_GPU_CPU_LOUDNORM_EARLY_PREFETCH", true);
  const earlyCpuPrefetchLimit = Math.max(1, intNum(process.env.LOUDNORM_GPU_CPU_LOUDNORM_EARLY_PREFETCH_LIMIT, 1));
  const processingPlans = useGpuSourcePort && fallbackFirst && fallbackPlans.length > 0
    ? [...fallbackPlans, ...audioPlans.filter((plan) => !plan.stereoFallback)]
    : audioPlans;
  const processingOrder = new Map(processingPlans.map((plan, idx) => [plan.idx, idx]));

  const prefetchCpuLoudnormFrom = (afterPlanIdx, maxStarts = 1, reason = "while current GPU work runs") => {
    if (!useGpuSourcePort || maxStarts <= 0) return;
    let started = 0;
    for (let idx = afterPlanIdx; idx < processingPlans.length; idx += 1) {
      const nextPlan = processingPlans[idx];
      const key = cpuLoudnormKey(nextPlan);
      const externalCached = (!gpuFirstPassMeasure && sourceChannelsFor(nextPlan) === nextPlan.channels) ? cachedCpuLoudnorm(args, nextPlan.sourceIdx) : null;
      if (cpuLoudnormResults.has(key) || cpuLoudnormTasks.has(key) || externalCached) continue;
      args.jobLog(`GPU normalize scheduling CPU loudnorm prefetch for ${planLabelFor(nextPlan)} ${reason}`);
      startCpuLoudnormTask(nextPlan, { background: true });
      started += 1;
      if (started >= maxStarts) return;
    }
  };
  const prefetchNextCpuLoudnorm = (afterPlanIdx) => prefetchCpuLoudnormFrom(afterPlanIdx, 1);

  const splitStatsDefault = fallbackPlans.length > 0;
  const splitFallbackStatsEnabled = envFlag("LOUDNORM_GPU_SPLIT_FALLBACK_STATS", splitStatsDefault);
  const splitOriginalStatsEnabled = envFlag("LOUDNORM_GPU_SPLIT_ORIGINAL_STATS", splitStatsDefault);
  const splitPrefetchNextStats = envFlag("LOUDNORM_GPU_SPLIT_PREFETCH_NEXT_STATS", splitStatsDefault);
  const splitPrefetchNextStatsDuringStats = splitPrefetchNextStats && envFlag("LOUDNORM_GPU_PREFETCH_NEXT_SPLIT_STATS_DURING_STATS", false);
  const splitPrefetchNextStatsAtProgress = splitPrefetchNextStats
    ? Math.max(0, Math.min(1, num(process.env.LOUDNORM_GPU_PREFETCH_NEXT_SPLIT_STATS_AT_PROGRESS, 0)))
    : 0;
  const fuseStereoFallbackMeasureStats = envFlag("LOUDNORM_GPU_STEREO_FALLBACK_FUSE_MEASURE_STATS", false);
  const fuseOriginalMeasureStats = envFlag("LOUDNORM_GPU_ORIGINAL_FUSE_MEASURE_STATS", false);
  const splitStatsKey = (plan, statsSampleRate) => `${plan.idx}:${plan.sourceIdx}:${plan.channels}:${statsSampleRate}`;
  const hasFallbackForPlan = (plan) => fallbackPlans.some((fallbackPlan) => fallbackPlan.sourceIdx === plan.sourceIdx);
  const canSplitStatsPlan = (plan) => useGpuSourcePort
    && useStreamingSourcePort
    && !gpuFirstPassMeasure
    && (plan.stereoFallback ? splitFallbackStatsEnabled : (splitOriginalStatsEnabled && hasFallbackForPlan(plan)));
  const canFuseCpuLoudnormWithSplitStats = (plan) => fuseStereoFallbackMeasureStats
    && canSplitStatsPlan(plan)
    && usesStereoFallbackSourcePath(plan);
  const canFuseOriginalCpuLoudnormWithSplitStats = (plan) => fuseOriginalMeasureStats
    && canSplitStatsPlan(plan)
    && !plan.stereoFallback
    && !needsInlineStereoDownmix(plan)
    && !!plan.channelLayout;
  const canFuseAnyCpuLoudnormWithSplitStats = (plan) => canFuseCpuLoudnormWithSplitStats(plan)
    || canFuseOriginalCpuLoudnormWithSplitStats(plan);
  const splitStatsNeedsMeasuredValues = (plan) => !plan.stereoFallback && plan.sourceSampleRate > 0;
  const knownCpuLoudnormValues = (plan) => {
    const cached = sourceChannelsFor(plan) === plan.channels ? cachedCpuLoudnorm(args, plan.sourceIdx) : null;
    return (cpuLoudnormResults.get(cpuLoudnormKey(plan)) || {}).values || cached;
  };
  const pairStereoFallbackSplitStats = envFlag("LOUDNORM_GPU_PAIR_FALLBACK_STATS") && args.platform !== "win32";
  const pairStereoFallbackSplitStatsSingleRuntime = pairStereoFallbackSplitStats && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_STATS_SINGLE_RUNTIME");
  const pairStereoFallbackSplitStatsSinglePipe = pairStereoFallbackSplitStatsSingleRuntime && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_STATS_SINGLE_PIPE");
  const buildStatsRuntimePlan = (plan, statsSampleRate, statsCache, statsDecodeCommand, extraArgs = []) => [
    ...gpuPlanCoreCommand(), "-", "-",
    "--rate", String(statsSampleRate), "--channels", String(plan.channels),
    "--target-i", String(targetI), "--target-lra", String(targetLra), "--target-tp", String(targetTp),
    "--max-gain-db", String(maxGain), "--chunk-mib", q(chunkMiBFor(plan)),
    "--input-format", q(plan.rawInputFormat),
    "--output-format", q(plan.rawGpuFormat),
    "--ptx-path", q(`${RUNTIME_CUDA}/loudnorm_source_port_kernels.ptx`), "--source-core-path", q(sourceCorePath),
    "--streaming-io", "--expected-seconds", String(Math.max(1, durationSeconds)),
    "--decode-command-json", q(JSON.stringify(statsDecodeCommand)),
    "--ffmpeg-limiter", "--ffmpeg-gain-offset-ms", "210",
    "--stats-cache-output", q(statsCache), "--stats-cache-only",
    ...extraArgs,
    ...(usesStereoFallbackSourcePath(plan) ? ["--stereo-fallback-source-exact"] : []),
  ].join(" ");
  const pairedSplitStatsPartner = (plan) => {
    if (!pairStereoFallbackSplitStats || !plan.stereoFallback || !usesStereoFallbackSourcePath(plan)) return null;
    const partner = audioPlans.find((candidate) => !candidate.stereoFallback && candidate.sourceIdx === plan.sourceIdx);
    if (!partner || !canSplitStatsPlan(partner) || !partner.channelLayout) return null;
    if (partner.rawInputFormat !== plan.rawInputFormat || partner.rawGpuFormat !== plan.rawGpuFormat) return null;
    return partner;
  };
  const startPairedSplitStatsTask = (plan, partner, statsSampleRate, statsCache, statsErr, key, reason, parseLine) => {
    const partnerCpuValues = knownCpuLoudnormValues(partner);
    const partnerStatsSampleRate = processingSampleRateFor(partner, partnerCpuValues);
    const partnerKey = splitStatsKey(partner, partnerStatsSampleRate);
    if (splitStatsResults.has(partnerKey) || splitStatsTasks.has(partnerKey)) return null;
    const { statsCache: partnerStatsCache, statsErr: partnerStatsErr } = trackStatsPaths(partner, partnerStatsSampleRate);
    const fallbackFifo = `${plan.fifoInput}.stats`;
    const originalFifo = `${partner.fifoInput}.stats`;
    const fallbackDecodeCommand = ["cat", fallbackFifo];
    const originalDecodeCommand = ["cat", originalFifo];
    const useSingleRuntime = pairStereoFallbackSplitStatsSingleRuntime && statsSampleRate === partnerStatsSampleRate;
    const useSinglePipe = useSingleRuntime && pairStereoFallbackSplitStatsSinglePipe;
    const combinedDecodeCommand = [
      args.ffmpegPath, "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-i", plan.sourceInput,
      "-filter_complex", `[0:a:${plan.sourceAudioIdx}]asplit=2[orig_in][stereo_in];[orig_in]aformat=channel_layouts=${partner.channelLayout}[orig_raw];[stereo_in]aformat=channel_layouts=stereo[stereo_raw];[orig_raw][stereo_raw]amerge=inputs=2[paired_raw]`,
      "-map", "[paired_raw]", "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, "pipe:1",
    ];
    const pairedStatsExtraArgs = useSingleRuntime ? [
      "--paired-stats-decode-command-json", q(JSON.stringify(originalDecodeCommand)),
      "--paired-stats-cache-output", q(partnerStatsCache),
      "--paired-stats-channels", String(partner.channels),
      "--paired-stats-rate", String(partnerStatsSampleRate),
      ...(usesStereoFallbackSourcePath(partner) ? ["--paired-stats-stereo-fallback-source-exact"] : []),
    ] : [];
    const originalPrimaryPairedStatsExtraArgs = useSingleRuntime ? [
      "--paired-stats-decode-command-json", q(JSON.stringify(fallbackDecodeCommand)),
      "--paired-stats-cache-output", q(statsCache),
      "--paired-stats-channels", String(plan.channels),
      "--paired-stats-rate", String(statsSampleRate),
      ...(useSinglePipe ? [
        "--paired-stats-combined-decode-command-json", q(JSON.stringify(combinedDecodeCommand)),
        "--paired-stats-combined-channels", String(partner.channels + plan.channels),
      ] : []),
      ...(usesStereoFallbackSourcePath(plan) ? ["--paired-stats-stereo-fallback-source-exact"] : []),
    ] : [];
    const fallbackStatsPlan = buildStatsRuntimePlan(plan, statsSampleRate, statsCache, fallbackDecodeCommand, pairedStatsExtraArgs);
    const originalStatsPlan = buildStatsRuntimePlan(partner, partnerStatsSampleRate, partnerStatsCache, originalDecodeCommand);
    const singleRuntimeStatsPlan = useSingleRuntime
      ? buildStatsRuntimePlan(partner, partnerStatsSampleRate, partnerStatsCache, originalDecodeCommand, originalPrimaryPairedStatsExtraArgs)
      : fallbackStatsPlan;
    const filterGraph = `[0:a:${plan.sourceAudioIdx}]asplit=2[orig_in][stereo_in];[orig_in]aformat=channel_layouts=${partner.channelLayout}[orig_raw];[stereo_in]aformat=channel_layouts=stereo[stereo_raw]`;
    const ffmpegStatsDecode = [
      q(args.ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", q(plan.sourceInput),
      "-filter_complex", q(filterGraph),
      "-map", "[stereo_raw]", "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, q(fallbackFifo),
      "-map", "[orig_raw]", "-ar", String(partnerStatsSampleRate), "-f", partner.rawInputFormat, q(originalFifo),
    ].join(" ");
    const script = useSinglePipe ? [
      `rm -f ${q(statsErr)} ${q(partnerStatsErr)}`,
      `(${singleRuntimeStatsPlan}) 2>&1 | tee -a ${q(statsErr)} ${q(partnerStatsErr)}`,
    ].join("\n") : useSingleRuntime ? [
      `rm -f ${q(fallbackFifo)} ${q(originalFifo)} ${q(statsErr)} ${q(partnerStatsErr)}`,
      `mkfifo ${q(fallbackFifo)} ${q(originalFifo)}`,
      `pids=""`,
      `cleanup(){ for p in $pids; do kill "$p" 2>/dev/null || true; done; rm -f ${q(fallbackFifo)} ${q(originalFifo)}; }`,
      `trap cleanup EXIT`,
      `(${singleRuntimeStatsPlan}) 2>&1 | tee -a ${q(statsErr)} ${q(partnerStatsErr)} & pid_pair=$!; pids="$pids $pid_pair"`,
      `${ffmpegStatsDecode}`,
      `ffmpeg_code=$?`,
      `if [ "$ffmpeg_code" -ne 0 ]; then kill "$pid_pair" 2>/dev/null || true; wait "$pid_pair" 2>/dev/null; exit "$ffmpeg_code"; fi`,
      `wait "$pid_pair"; pair_code=$?`,
      `if [ "$pair_code" -ne 0 ]; then exit "$pair_code"; fi`,
    ].join("\n") : [
      `rm -f ${q(fallbackFifo)} ${q(originalFifo)} ${q(statsErr)} ${q(partnerStatsErr)}`,
      `mkfifo ${q(fallbackFifo)} ${q(originalFifo)}`,
      `pids=""`,
      `cleanup(){ for p in $pids; do kill "$p" 2>/dev/null || true; done; rm -f ${q(fallbackFifo)} ${q(originalFifo)}; }`,
      `trap cleanup EXIT`,
      `(${fallbackStatsPlan}) 2>&1 | tee -a ${q(statsErr)} & pid_fb=$!; pids="$pids $pid_fb"`,
      `(${originalStatsPlan}) 2>&1 | tee -a ${q(partnerStatsErr)} & pid_orig=$!; pids="$pids $pid_orig"`,
      `${ffmpegStatsDecode}`,
      `ffmpeg_code=$?`,
      `if [ "$ffmpeg_code" -ne 0 ]; then kill "$pid_fb" "$pid_orig" 2>/dev/null || true; wait "$pid_fb" 2>/dev/null; wait "$pid_orig" 2>/dev/null; exit "$ffmpeg_code"; fi`,
      `wait "$pid_fb"; fb_code=$?`,
      `wait "$pid_orig"; orig_code=$?`,
      `if [ "$fb_code" -ne 0 ]; then exit "$fb_code"; fi`,
      `if [ "$orig_code" -ne 0 ]; then exit "$orig_code"; fi`,
    ].join("\n");
    args.jobLog(`GPU normalize paired split stats prepass enabled for ${planLabelFor(plan)} + ${planLabelFor(partner)} ${reason} rates=${statsSampleRate},${partnerStatsSampleRate}${useSingleRuntime ? " single_runtime=true" : ""}${useSinglePipe ? " single_pipe=true" : ""}`);
    const pairTask = runShell(script, {
      args,
      label: `GPU paired streaming stats ${planLabelFor(plan)} + ${planLabelFor(partner)}`,
      allowedCodes: [0],
      capturePath: "",
      logOnSuccess: debugLogging,
      parseLine,
    }).then((res) => {
      if (res.code !== 0) throw new Error(`GPU paired streaming stats failed on ${planLabelFor(plan)} + ${planLabelFor(partner)}`);
      const result = { ...res, statsSampleRate, statsCache, pairedStats: true };
      const partnerResult = { ...res, statsSampleRate: partnerStatsSampleRate, statsCache: partnerStatsCache, pairedStats: true };
      splitStatsResults.set(key, result);
      splitStatsResults.set(partnerKey, partnerResult);
      return { result, partnerResult };
    });
    const task = pairTask.then(({ result }) => result);
    task.statsSampleRate = statsSampleRate;
    task.statsCache = statsCache;
    const partnerTask = pairTask.then(({ partnerResult }) => partnerResult);
    partnerTask.statsSampleRate = partnerStatsSampleRate;
    partnerTask.statsCache = partnerStatsCache;
    splitStatsTasks.set(key, task);
    splitStatsTasks.set(partnerKey, partnerTask);
    return task;
  };
  const startSplitStatsTask = (plan, reason, parseLine = () => {}, cpuLoudnormValuesForStats = null) => {
    const statsSampleRate = processingSampleRateFor(plan, cpuLoudnormValuesForStats);
    const key = splitStatsKey(plan, statsSampleRate);
    const { statsCache, statsErr } = trackStatsPaths(plan, statsSampleRate);
    const existingResult = splitStatsResults.get(key);
    if (existingResult) {
      const resolved = Promise.resolve(existingResult);
      resolved.statsSampleRate = statsSampleRate;
      resolved.statsCache = statsCache;
      return resolved;
    }
    const existingTask = splitStatsTasks.get(key);
    if (existingTask) return existingTask;
    const planLabel = planLabelFor(plan);
    const measureKey = cpuLoudnormKey(plan);
    const fuseCpuMeasure = canFuseAnyCpuLoudnormWithSplitStats(plan)
      && !cpuLoudnormResults.has(measureKey)
      && !cpuLoudnormTasks.has(measureKey);
    const partner = fuseCpuMeasure ? null : pairedSplitStatsPartner(plan);
    if (partner) {
      const pairedTask = startPairedSplitStatsTask(plan, partner, statsSampleRate, statsCache, statsErr, key, reason, parseLine);
      if (pairedTask) return pairedTask;
    }
    const fusedFilterGraph = fuseCpuMeasure && canFuseOriginalCpuLoudnormWithSplitStats(plan)
      ? `[0:a:${plan.sourceAudioIdx}]asplit=2[measure_in][raw_in];[measure_in]${loudnormFilter()}[measure_out];[raw_in]aformat=channel_layouts=${plan.channelLayout}[gpu_raw]`
      : `[0:a:${plan.sourceAudioIdx}]aformat=channel_layouts=stereo,asplit=2[gpu_raw][measure_in];[measure_in]${loudnormFilter()}[measure_out]`;
    const statsDecodeCommand = fuseCpuMeasure ? [
      String(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-y", "-i", String(plan.sourceInput),
      "-filter_complex", fusedFilterGraph,
      "-map", "[gpu_raw]", "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, "pipe:1",
      "-map", "[measure_out]", "-f", "null", (args.platform === "win32" ? "NUL" : "/dev/null"),
    ] : [
      String(args.ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", String(plan.sourceInput),
      "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...decodeAudioArgs(plan), "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, "pipe:1",
    ];
    const statsPlan = buildStatsRuntimePlan(plan, statsSampleRate, statsCache, statsDecodeCommand);
    args.jobLog(`GPU normalize split stats prepass enabled for ${planLabel} ${reason} rate=${statsSampleRate}${fuseCpuMeasure ? " fused_cpu_loudnorm=true" : ""}`);
    const task = runShell(wrapRuntimeProfile(statsPlan, plan, "stats"), {
      args,
      label: `GPU streaming stats ${planLabel}`,
      allowedCodes: [0],
      capturePath: statsErr,
      logOnSuccess: debugLogging,
      parseLine,
    }).then((res) => {
      if (res.code !== 0) throw new Error(`GPU streaming stats failed on ${planLabel}`);
      const result = { ...res, statsSampleRate, statsCache };
      if (fuseCpuMeasure) {
        let loudnormText = res.output;
        if (!String(loudnormText || "").includes("target_offset") && fs.existsSync(statsErr)) loudnormText = fs.readFileSync(statsErr, "utf8");
        const values = parseLoudnormJson(loudnormText);
        for (const loudnormKey of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) loudnormNumber(values, loudnormKey);
        const measureResult = {
          values,
          wallSec: 0,
          source: "fused_split_stats",
          background: false,
          queuedSec: 0,
          fusedStatsSec: res.wallSec,
        };
        cpuLoudnormResults.set(measureKey, measureResult);
        result.cpuLoudnormRecord = measureResult;
        args.jobLog(`GPU normalize CPU loudnorm first pass ${planLabel} fused with split stats: ${JSON.stringify(values)}`);
      }
      splitStatsResults.set(key, result);
      return result;
    });
    if (fuseCpuMeasure) cpuLoudnormTasks.set(measureKey, task.then((result) => result.cpuLoudnormRecord));
    task.statsSampleRate = statsSampleRate;
    task.statsCache = statsCache;
    splitStatsTasks.set(key, task);
    return task;
  };
  const prefetchNextSplitStats = (plan, reason) => {
    if (!splitPrefetchNextStats) return false;
    const currentOrder = processingOrder.get(plan.idx) || 0;
    for (let nextIdx = currentOrder + 1; nextIdx < processingPlans.length; nextIdx += 1) {
      const nextPlan = processingPlans[nextIdx];
      if (!canSplitStatsPlan(nextPlan)) continue;
      const nextCpuValues = knownCpuLoudnormValues(nextPlan);
      if (splitStatsNeedsMeasuredValues(nextPlan) && !nextCpuValues && !canFuseAnyCpuLoudnormWithSplitStats(nextPlan)) startCpuLoudnormTask(nextPlan, { background: true });
      startSplitStatsTask(nextPlan, reason, undefined, nextCpuValues || null);
      return true;
    }
    return false;
  };

  const streamParallelismDefault = 1;
  const streamParallelism = Math.max(1, intNum(process.env.LOUDNORM_GPU_STREAM_PARALLELISM, streamParallelismDefault));
  const useStreamParallelism = useGpuSourcePort && useStreamingSourcePort && !gpuFirstPassMeasure && processingPlans.length > 1 && streamParallelism > 1;

  const runLimitedParallel = async (items, limit, worker) => {
    const results = new Array(items.length);
    let nextIndex = 0;
    let firstError = null;
    const workerCount = Math.min(limit, items.length);
    const runners = Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const idx = nextIndex;
        nextIndex += 1;
        try {
          results[idx] = await worker(items[idx], idx);
        } catch (err) {
          if (!firstError) firstError = err;
        }
      }
    });
    await Promise.all(runners);
    if (firstError) throw firstError;
    return results;
  };

  const cancelBackgroundCpu = () => {
    backgroundCpuGroup.cancelled = true;
    for (const proc of Array.from(backgroundCpuGroup.procs)) {
      try { proc.kill("SIGTERM"); } catch (_) { /* noop */ }
    }
  };
  const settleCpuLoudnormTasks = async () => {
    await Promise.allSettled(Array.from(cpuLoudnormTasks.values()));
  };

  const copyOriginalPackage = async (reason, progressBase) => {
    cancelBackgroundCpu();
    await settleCpuLoudnormTasks();
    args.jobLog(`GPU Normalize Audio result: ${reason}`);
    const copyRes = await runChecked(copyOriginal, {
      label: "copy original package",
      parseLine: (line) => {
        const fraction = ffmpegProgressFraction(line, durationSeconds);
        if (fraction !== null) updateProgress(progressBase + (totalWork - progressBase) * fraction);
      },
    });
    logProfileStage(args, { scope: "plugin", name: "copy_original", wall_sec: copyRes.wallSec });
    const verifyCopyRes = await runChecked(`test -s ${q(tmpOutputFilePath)}`, { label: "verify copied package" });
    logProfileStage(args, { scope: "plugin", name: "verify_output", wall_sec: verifyCopyRes.wallSec });
    const publishCopyRes = await runChecked(`mv -f ${q(tmpOutputFilePath)} ${q(outputFilePath)}`, { label: "publish copied package" });
    logProfileStage(args, { scope: "plugin", name: "publish_output", wall_sec: publishCopyRes.wallSec });
    const cleanupRes = await runChecked(cleanupAll, { label: "cleanup GPU normalize intermediates" });
    logProfileStage(args, { scope: "plugin", name: "cleanup", wall_sec: cleanupRes.wallSec });
    logProfileStage(args, { scope: "plugin", name: "whole_plugin", wall_sec: (Date.now() - pluginStartedAt) / 1000 });
    args.jobLog("GPU Normalize Audio result: original package copied unchanged.");
    if (typeof args.updateWorker === "function") args.updateWorker({ percentage: 100, ETA: "0:00:00" });
    return { outputFileObj: { _id: outputFilePath }, outputNumber: 1, variables: args.variables };
  };

  if (debugLogging) {
    args.jobLog(useGpuSourcePort
      ? "Running GPU normalize: FFmpeg decode -> CUDA loudness/gain plan+apply -> FFmpeg encode/mux"
      : "Running GPU normalize: FFmpeg decode -> source-core exact gains -> CUDA apply -> FFmpeg encode/mux");
    args.jobLog(`GPU normalize Tdarr worker: worker_type=${workerType || "unknown"} require_gpu_worker=${requireGpuWorker ? "true" : "false"}`);
    logDebugPlanSummary();
    if (processingPlans !== audioPlans) args.jobLog(`GPU normalize processing order: ${processingPlans.map(planLabelFor).join(" -> ")}`);
    if (stereoFallbackSourceExact) args.jobLog("GPU normalize stereo fallback source-exact path enabled");
    for (const plan of audioPlans) {
      args.jobLog(`GPU normalize ${plan.sourceIdx}${plan.stereoFallback ? " stereo fallback" : ""}: estimated_raw_input_mib=${(plan.estimatedRawInputBytes / (1024 * 1024)).toFixed(1)} estimated_raw_output_mib=${(plan.estimatedRawOutputBytes / (1024 * 1024)).toFixed(1)} streaming_io=${useStreamingSourcePort ? "true" : "false"}`);
    }
  }

  const releaseConcurrencyLock = await acquireConcurrencyLock(args, args.inputs.lockFile, args.inputs.maxConcurrentJobs);
  try {
  if (earlyCpuPrefetch) prefetchCpuLoudnormFrom(1, earlyCpuPrefetchLimit, "before first GPU stream starts");
  let completedWork = 0;
  updateProgress(0, true);
  if (useStreamParallelism) {
    args.jobLog(`GPU normalize stream parallelism enabled: ${Math.min(streamParallelism, processingPlans.length)} concurrent streams inside this job`);
    const planProgress = new Map(processingPlans.map((plan) => [plan.idx, 0]));
    const reportPlanProgress = (plan, workDone, force = false) => {
      const bounded = Math.max(planProgress.get(plan.idx) || 0, Math.min(plan.work, workDone));
      planProgress.set(plan.idx, bounded);
      const totalDone = Array.from(planProgress.values()).reduce((sum, value) => sum + value, 0);
      updateProgress(totalDone, force);
    };
    const measuredPlans = new Map();
    const measureResults = await Promise.all(processingPlans.map(async (plan) => {
      const streamStartedAt = Date.now();
      const planLabel = planLabelFor(plan);
      args.jobLog(`GPU Normalize Audio step: ${describePlan(plan)}.`);
      const measureSpan = plan.work * 0.18;
      const measureRecord = await getCpuLoudnormRecord(plan);
      const cpuLoudnormValues = measureRecord.values;
      if (measureRecord.reused || measureRecord.source !== "measured") {
        const measureSource = measureRecord.source === "measured" && measureRecord.reused ? "reused" : measureRecord.source;
        args.jobLog(`GPU Normalize Audio step: using ${measureSource} loudness measurement for ${planLabel}.`);
        if (debugLogging) args.jobLog(`GPU normalize using ${measureSource} CPU loudnorm first pass ${planLabel}: ${JSON.stringify(cpuLoudnormValues)}`);
      }
      const inputI = loudnormNumber(cpuLoudnormValues, "input_i");
      const gainNeeded = targetI - inputI;
      args.jobLog(`GPU Normalize Audio decision: ${planLabel} needs ${gainNeeded.toFixed(2)} LU gain; limit is ${maxGain.toFixed(2)} LU.`);
      const cpuWaitSec = measureRecord.waitSec || 0;
      const cpuOverlapSec = Math.max(0, measureRecord.wallSec - cpuWaitSec);
      logProfileStage(args, { scope: "plugin", name: "cpu_loudnorm_first_pass", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: measureRecord.wallSec, wait_sec: cpuWaitSec, overlap_sec: cpuOverlapSec, queued_sec: measureRecord.queuedSec || 0, source: measureRecord.source || "measured", cached: measureRecord.source === "external_cached" ? 1 : 0, reused: measureRecord.reused ? 1 : 0, prefetched: measureRecord.source === "prefetched" ? 1 : 0, background: measureRecord.background ? 1 : 0 });
      reportPlanProgress(plan, measureSpan, true);
      measuredPlans.set(plan.idx, { cpuLoudnormValues, streamStartedAt });
      if (maxGain > 0 && gainNeeded > maxGain) {
        return { copyOriginalReason: `GPU normalize gain gate exceeded on ${planLabel}; copying original package` };
      }
      return { copyOriginalReason: "" };
    }));
    const gainGate = measureResults.find((result) => result && result.copyOriginalReason);
    if (gainGate) {
      return await copyOriginalPackage(gainGate.copyOriginalReason, Array.from(planProgress.values()).reduce((sum, value) => sum + value, 0));
    }

    const streamResults = await runLimitedParallel(processingPlans, streamParallelism, async (plan) => {
      const measured = measuredPlans.get(plan.idx);
      const cpuLoudnormValues = measured.cpuLoudnormValues;
      const planLabel = planLabelFor(plan);
      const measureSpan = plan.work * 0.18;
      const decodeSpan = plan.work * 0.08;
      const normalizeSpan = plan.work * 0.54;
      const encodeSpan = plan.work * 0.2;
      const processingSampleRate = processingSampleRateFor(plan, cpuLoudnormValues);
      const decodeCommand = [
        String(args.ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", String(plan.sourceInput),
        "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...decodeAudioArgs(plan), "-ar", String(processingSampleRate), "-f", plan.rawInputFormat, "pipe:1",
      ];
      const encodeCommand = [
        String(args.ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-f", plan.rawGpuFormat, ...rawInputAudioArgs(plan, cpuLoudnormValues),
        "-i", "pipe:0", ...encodeSampleRateArgsFor(plan, cpuLoudnormValues), "-c:a", "aac", "-b:a", audioBitrate, plan.normalizedAudio,
      ];
      const gpuPlan = [
        ...gpuPlanCoreCommand(), "-", "-",
        "--rate", String(processingSampleRate), "--channels", String(plan.channels),
        "--target-i", String(targetI), "--target-lra", String(targetLra), "--target-tp", String(targetTp),
        "--max-gain-db", String(maxGain), "--chunk-mib", q(applyChunkMiBFor(plan)),
        "--measured-i", String(loudnormNumber(cpuLoudnormValues, "input_i")),
        "--measured-lra", String(loudnormNumber(cpuLoudnormValues, "input_lra")),
        "--measured-tp", String(loudnormNumber(cpuLoudnormValues, "input_tp")),
        "--measured-thresh", String(loudnormNumber(cpuLoudnormValues, "input_thresh")),
        "--offset-db", String(loudnormNumber(cpuLoudnormValues, "target_offset")), "--ffmpeg-linear", "--disable-short-source-exact", "--ffmpeg-limiter", "--ffmpeg-gain-offset-ms", "210",
        "--input-format", q(plan.rawInputFormat),
        "--output-format", q(plan.rawGpuFormat),
        "--ptx-path", q(`${RUNTIME_CUDA}/loudnorm_source_port_kernels.ptx`), "--source-core-path", q(sourceCorePath),
        "--streaming-io", "--parallel-final-apply", "--expected-seconds", String(Math.max(1, durationSeconds)),
        "--decode-command-json", q(JSON.stringify(decodeCommand)),
        "--encode-command-json", q(JSON.stringify(encodeCommand)),
        ...(usesStereoFallbackSourcePath(plan) ? ["--stereo-fallback-source-exact"] : []),
      ].join(" ");
      const gpuRes = await runShell(wrapRuntimeProfile(gpuPlan, plan, "streaming"), {
        args,
        label: `GPU streaming normalize ${planLabel}`,
        allowedCodes: [0, 42],
        capturePath: plan.sourceErr,
        logOnSuccess: debugLogging,
        parseLine: (line) => {
          const fraction = gpuProgressFraction(line);
          if (fraction !== null) reportPlanProgress(plan, measureSpan + decodeSpan + normalizeSpan * fraction);
        },
      });
      logProfileStage(args, { scope: "plugin", name: "gpu_source_port_streaming", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: gpuRes.wallSec });
      if (gpuRes.code === 42) {
        return { copyOriginalReason: `GPU normalize gain gate exceeded on ${planLabel}; copying original package` };
      }
      if (gpuRes.code !== 0) throw new Error(`GPU streaming normalize failed on ${planLabel}`);
      reportPlanProgress(plan, measureSpan + decodeSpan + normalizeSpan + encodeSpan, true);
      const cleanupRaw = `rm -f ${cleanupFilesForPlan(plan).filter((file) => file !== plan.normalizedAudio).map(q).join(" ")}`;
      const cleanupStreamRes = await runChecked(cleanupRaw, { label: `cleanup ${planLabel}` });
      logProfileStage(args, { scope: "plugin", name: "cleanup_stream", stream: plan.idx, source_stream: plan.sourceIdx, wall_sec: cleanupStreamRes.wallSec });
      args.jobLog(`GPU Normalize Audio result: ${describePlan(plan)} completed.`);
      reportPlanProgress(plan, plan.work, true);
      logProfileStage(args, { scope: "plugin", name: "per_stream_total", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: (Date.now() - measured.streamStartedAt) / 1000 });
      return { copyOriginalReason: "" };
    });
    const runtimeGate = streamResults.find((result) => result && result.copyOriginalReason);
    if (runtimeGate) {
      return await copyOriginalPackage(runtimeGate.copyOriginalReason, Array.from(planProgress.values()).reduce((sum, value) => sum + value, 0));
    }
    completedWork = audioWork;
  } else {
  for (const plan of processingPlans) {
    const streamStartedAt = Date.now();
    const planLabel = planLabelFor(plan);
    args.jobLog(`GPU Normalize Audio step: ${describePlan(plan)}.`);
    const measureSpan = useGpuSourcePort ? plan.work * 0.18 : 0;
    const decodeSpan = plan.work * 0.08;
    const normalizeSpan = plan.work * (useGpuSourcePort ? 0.54 : 0.72);
    const encodeSpan = plan.work * 0.2;
    const splitStatsForPlan = canSplitStatsPlan(plan);
    let splitStatsPromise = null;
    let splitStatsCacheInput = null;
    let firstPassStatsCacheInput = null;
    let cpuLoudnormValues = null;
    if (useGpuSourcePort) {
      if (splitStatsForPlan) {
        if (!canFuseAnyCpuLoudnormWithSplitStats(plan)) startCpuLoudnormTask(plan, { background: true });
        let prefetchedNextStatsDuringCurrentStats = false;
        splitStatsPromise = startSplitStatsTask(plan, "before measured apply", (line) => {
          const fraction = gpuProgressFraction(line);
          if (fraction !== null) {
            updateProgress(completedWork + measureSpan + normalizeSpan * 0.5 * fraction);
            if (!prefetchedNextStatsDuringCurrentStats && splitPrefetchNextStatsAtProgress > 0 && fraction >= splitPrefetchNextStatsAtProgress) {
              prefetchedNextStatsDuringCurrentStats = prefetchNextSplitStats(plan, `after ${Math.round(splitPrefetchNextStatsAtProgress * 100)}% of ${planLabel} stats`);
            }
          }
        });
        if (splitPrefetchNextStatsDuringStats) prefetchNextSplitStats(plan, `while ${planLabel} stats runs`);
      }
      const measureRecord = await getCpuLoudnormRecord(plan, (line) => {
        const fraction = ffmpegProgressFraction(line, durationSeconds);
        if (fraction !== null) updateProgress(completedWork + measureSpan * fraction);
      });
      cpuLoudnormValues = measureRecord.values;
      firstPassStatsCacheInput = measureRecord.statsCache || null;
      if (measureRecord.reused || measureRecord.source !== "measured") {
        const measureSource = measureRecord.source === "measured" && measureRecord.reused ? "reused" : measureRecord.source;
        args.jobLog(`GPU Normalize Audio step: using ${measureSource} loudness measurement for ${planLabel}.`);
        if (debugLogging) args.jobLog(`GPU normalize using ${measureSource} CPU loudnorm first pass ${planLabel}: ${JSON.stringify(cpuLoudnormValues)}`);
      }
      const inputI = loudnormNumber(cpuLoudnormValues, "input_i");
      const gainNeeded = targetI - inputI;
      args.jobLog(`GPU Normalize Audio decision: ${planLabel} needs ${gainNeeded.toFixed(2)} LU gain; limit is ${maxGain.toFixed(2)} LU.`);
      const cpuWaitSec = measureRecord.waitSec || 0;
      const cpuOverlapSec = Math.max(0, measureRecord.wallSec - cpuWaitSec);
      logProfileStage(args, { scope: "plugin", name: "cpu_loudnorm_first_pass", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: measureRecord.wallSec, wait_sec: cpuWaitSec, overlap_sec: cpuOverlapSec, queued_sec: measureRecord.queuedSec || 0, source: measureRecord.source || "measured", cached: measureRecord.source === "external_cached" ? 1 : 0, reused: measureRecord.reused ? 1 : 0, prefetched: measureRecord.source === "prefetched" ? 1 : 0, background: measureRecord.background ? 1 : 0 });
      updateProgress(completedWork + measureSpan, true);
      if (maxGain > 0 && gainNeeded > maxGain) {
        if (splitStatsPromise) await splitStatsPromise;
        return await copyOriginalPackage(`GPU normalize gain gate exceeded on ${planLabel}; copying original package`, completedWork + measureSpan);
      }
      const statsSampleRate = processingSampleRateFor(plan, cpuLoudnormValues);
      if (splitStatsPromise && splitStatsPromise.statsSampleRate !== statsSampleRate) {
        args.jobLog(`GPU normalize split stats prepass sample rate changed for ${planLabel}: cache=${splitStatsPromise.statsSampleRate} runtime=${statsSampleRate}; rerunning stats`);
        try {
          await splitStatsPromise;
        } catch (err) {
          args.jobLog(`GPU normalize ignored stale split stats prepass for ${planLabel}: ${err.message}`);
        }
        splitStatsPromise = null;
      }
      if (splitStatsForPlan && !splitStatsPromise) {
        splitStatsPromise = startSplitStatsTask(plan, "after measured values", (line) => {
          const fraction = gpuProgressFraction(line);
          if (fraction !== null) updateProgress(completedWork + measureSpan + normalizeSpan * 0.5 * fraction);
        }, cpuLoudnormValues);
      }
      if (splitStatsPromise) {
        const statsRes = await splitStatsPromise;
        splitStatsCacheInput = statsRes.statsCache || plan.statsCache;
        logProfileStage(args, { scope: "plugin", name: "gpu_source_port_streaming_stats", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: statsRes.wallSec });
      }
      prefetchNextSplitStats(plan, `while ${planLabel} apply runs`);
      prefetchNextCpuLoudnorm((processingOrder.get(plan.idx) || 0) + 1);
    }
    if (useStreamingSourcePort) {
      const processingSampleRate = processingSampleRateFor(plan, cpuLoudnormValues);
      const decodeCommand = [
        String(args.ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", String(plan.sourceInput),
        "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...decodeAudioArgs(plan), "-ar", String(processingSampleRate), "-f", plan.rawInputFormat, "pipe:1",
      ];
      const encodeCommand = [
        String(args.ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-f", plan.rawGpuFormat, ...rawInputAudioArgs(plan, cpuLoudnormValues),
        "-i", "pipe:0", ...encodeSampleRateArgsFor(plan, cpuLoudnormValues), "-c:a", "aac", "-b:a", audioBitrate, plan.normalizedAudio,
      ];
      const gpuPlan = [
        ...gpuPlanCoreCommand(), "-", "-",
        "--rate", String(processingSampleRate), "--channels", String(plan.channels),
        "--target-i", String(targetI), "--target-lra", String(targetLra), "--target-tp", String(targetTp),
        "--max-gain-db", String(maxGain), "--chunk-mib", q(applyChunkMiBFor(plan)),
        "--measured-i", String(loudnormNumber(cpuLoudnormValues, "input_i")),
        "--measured-lra", String(loudnormNumber(cpuLoudnormValues, "input_lra")),
        "--measured-tp", String(loudnormNumber(cpuLoudnormValues, "input_tp")),
        "--measured-thresh", String(loudnormNumber(cpuLoudnormValues, "input_thresh")),
        "--offset-db", String(loudnormNumber(cpuLoudnormValues, "target_offset")), "--ffmpeg-linear", "--disable-short-source-exact", "--ffmpeg-limiter", "--ffmpeg-gain-offset-ms", "210",
        "--input-format", q(plan.rawInputFormat),
        "--output-format", q(plan.rawGpuFormat),
        "--ptx-path", q(`${RUNTIME_CUDA}/loudnorm_source_port_kernels.ptx`), "--source-core-path", q(sourceCorePath),
        "--streaming-io", "--parallel-final-apply", "--expected-seconds", String(Math.max(1, durationSeconds)),
        "--decode-command-json", q(JSON.stringify(decodeCommand)),
        "--encode-command-json", q(JSON.stringify(encodeCommand)),
        ...((splitStatsForPlan || firstPassStatsCacheInput) ? ["--stats-cache-input", q(splitStatsCacheInput || firstPassStatsCacheInput || plan.statsCache)] : []),
        ...(usesStereoFallbackSourcePath(plan) ? ["--stereo-fallback-source-exact"] : []),
      ].join(" ");
      const gpuRes = await runShell(wrapRuntimeProfile(gpuPlan, plan, "streaming"), {
        args,
        label: `GPU streaming normalize ${planLabel}`,
        allowedCodes: [0, 42],
        capturePath: plan.sourceErr,
        logOnSuccess: debugLogging,
        parseLine: (line) => {
          const fraction = gpuProgressFraction(line);
          if (fraction !== null) updateProgress(completedWork + measureSpan + decodeSpan + normalizeSpan * fraction);
        },
      });
      logProfileStage(args, { scope: "plugin", name: "gpu_source_port_streaming", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: gpuRes.wallSec });
      if (splitStatsForPlan || firstPassStatsCacheInput) logProfileStage(args, { scope: "plugin", name: "gpu_source_port_streaming_total", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: (Date.now() - streamStartedAt) / 1000 });
      if (gpuRes.code === 42) {
        return await copyOriginalPackage(`GPU normalize gain gate exceeded on ${planLabel}; copying original package`, completedWork + measureSpan + decodeSpan + normalizeSpan);
      }
      if (gpuRes.code !== 0) throw new Error(`GPU streaming normalize failed on ${planLabel}`);
      updateProgress(completedWork + measureSpan + decodeSpan + normalizeSpan + encodeSpan, true);
      const cleanupRaw = `rm -f ${cleanupFilesForPlan(plan).filter((file) => file !== plan.normalizedAudio).map(q).join(" ")}`;
      const cleanupStreamRes = await runChecked(cleanupRaw, { label: `cleanup ${planLabel}` });
      logProfileStage(args, { scope: "plugin", name: "cleanup_stream", stream: plan.idx, source_stream: plan.sourceIdx, wall_sec: cleanupStreamRes.wallSec });
      args.jobLog(`GPU Normalize Audio result: ${describePlan(plan)} completed.`);
      completedWork += plan.work;
      logProfileStage(args, { scope: "plugin", name: "per_stream_total", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: (Date.now() - streamStartedAt) / 1000 });
      updateProgress(completedWork, true);
      continue;
    }

    const processingSampleRate = processingSampleRateFor(plan, cpuLoudnormValues);
    const decode = [
      q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", q(plan.sourceInput),
      "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn", ...decodeAudioArgs(plan).map(q), "-ar", String(processingSampleRate), "-f", q(plan.rawInputFormat), q(plan.rawInput),
    ].join(" ");
    const decodeRes = await runChecked(decode, {
      label: `decode ${planLabel}`,
      parseLine: (line) => {
        const fraction = ffmpegProgressFraction(line, durationSeconds);
        if (fraction !== null) updateProgress(completedWork + measureSpan + decodeSpan * fraction);
      },
    });
    updateProgress(completedWork + measureSpan + decodeSpan, true);
    const decodedBytes = fs.statSync(plan.rawInput).size;
    if (debugLogging) args.jobLog(`GPU normalize ${planLabel}: raw_pcm_bytes=${decodedBytes} raw_pcm_mib=${(decodedBytes / (1024 * 1024)).toFixed(1)}`);
    logProfileStage(args, { scope: "plugin", name: "ffmpeg_decode", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: decodeRes.wallSec, raw_mib: decodedBytes / (1024 * 1024) });

    if (useGpuSourcePort) {
      const gpuPlan = [
        ...gpuPlanCoreCommand(), q(plan.rawInput), q(plan.rawGpu),
        "--rate", String(processingSampleRate), "--channels", String(plan.channels),
        "--target-i", String(targetI), "--target-lra", String(targetLra), "--target-tp", String(targetTp),
        "--max-gain-db", String(maxGain), "--chunk-mib", q(applyChunkMiBFor(plan)),
        "--measured-i", String(loudnormNumber(cpuLoudnormValues, "input_i")),
        "--measured-lra", String(loudnormNumber(cpuLoudnormValues, "input_lra")),
        "--measured-tp", String(loudnormNumber(cpuLoudnormValues, "input_tp")),
        "--measured-thresh", String(loudnormNumber(cpuLoudnormValues, "input_thresh")),
        "--offset-db", String(loudnormNumber(cpuLoudnormValues, "target_offset")), "--ffmpeg-linear", "--disable-short-source-exact", "--ffmpeg-limiter", "--ffmpeg-gain-offset-ms", "210",
        "--input-format", q(plan.rawInputFormat),
        "--output-format", q(plan.rawGpuFormat),
        "--ptx-path", q(`${RUNTIME_CUDA}/loudnorm_source_port_kernels.ptx`), "--source-core-path", q(sourceCorePath),
        ...(usesStereoFallbackSourcePath(plan) ? ["--stereo-fallback-source-exact"] : []),
      ].join(" ");
      const gpuRes = await runShell(wrapRuntimeProfile(gpuPlan, plan, "source-port"), {
        args,
        label: `GPU normalize ${planLabel}`,
        allowedCodes: [0, 42],
        capturePath: plan.sourceErr,
        logOnSuccess: debugLogging,
        parseLine: (line) => {
          const fraction = gpuProgressFraction(line);
          if (fraction !== null) updateProgress(completedWork + measureSpan + decodeSpan + normalizeSpan * fraction);
        },
      });
      logProfileStage(args, { scope: "plugin", name: "gpu_source_port", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: gpuRes.wallSec });
      if (gpuRes.code === 42) {
        return await copyOriginalPackage(`GPU normalize gain gate exceeded on ${planLabel}; copying original package`, completedWork + measureSpan + decodeSpan + normalizeSpan);
      }
      if (gpuRes.code !== 0) throw new Error(`GPU normalize failed on ${planLabel}`);
    } else {
      const source = [q(sourceCorePath), "--stream", q(plan.rawInput), "/dev/null", String(sampleRate), String(plan.channels), q(plan.gains), String(targetI), String(targetLra), String(targetTp)].join(" ");
      const sourceRes = await runChecked(source, {
        label: `source-core gains ${planLabel}`,
        capturePath: plan.sourceErr,
        logOnSuccess: debugLogging,
      });
      logProfileStage(args, { scope: "plugin", name: "source_core_gains", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: sourceRes.wallSec });
      const inputMatch = sourceRes.output.match(/input_i=([-+0-9.]+)/);
      if (maxGain > 0) {
        if (!inputMatch) throw new Error("GPU normalize: missing input_i in source metrics");
        const gainNeeded = targetI - Number.parseFloat(inputMatch[1]);
        args.jobLog(`GPU Normalize Audio decision: ${planLabel} needs ${gainNeeded.toFixed(2)} LU gain; limit is ${maxGain.toFixed(2)} LU.`);
        if (gainNeeded > maxGain) {
          return await copyOriginalPackage(`GPU normalize gain gate exceeded on ${planLabel}; copying original package`, completedWork + decodeSpan + normalizeSpan);
        }
      }
      const apply = [q(gpuApplyPath), q(plan.rawInput), q(plan.gains), q(plan.rawGpu), "--chunk-mib", q(applyChunkMiBFor(plan))].join(" ");
      updateProgress(completedWork + decodeSpan + normalizeSpan * 0.65, true);
      const applyRes = await runChecked(apply, { label: `GPU apply ${planLabel}`, logOnSuccess: debugLogging });
      logProfileStage(args, { scope: "plugin", name: "gpu_apply", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: applyRes.wallSec });
    }
    updateProgress(completedWork + measureSpan + decodeSpan + normalizeSpan, true);

    const encode = [
      q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-f", q(plan.rawGpuFormat), ...rawInputAudioArgs(plan, cpuLoudnormValues).map(q),
      "-i", q(plan.rawGpu), ...encodeSampleRateArgsFor(plan, cpuLoudnormValues).map(q), "-c:a", "aac", "-b:a", q(audioBitrate), q(plan.normalizedAudio),
    ].join(" ");
    const encodeRes = await runChecked(encode, {
      label: `encode ${planLabel}`,
      parseLine: (line) => {
        const fraction = ffmpegProgressFraction(line, durationSeconds);
        if (fraction !== null) updateProgress(completedWork + measureSpan + decodeSpan + normalizeSpan + encodeSpan * fraction);
      },
    });
    logProfileStage(args, { scope: "plugin", name: "ffmpeg_encode", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, raw_format: plan.rawGpuFormat, wall_sec: encodeRes.wallSec });
    const cleanupRaw = `rm -f ${[plan.rawInput, plan.gains, plan.measureErr, plan.sourceErr, plan.rawGpu].map(q).join(" ")}`;
    const cleanupStreamRes = await runChecked(cleanupRaw, { label: `cleanup ${planLabel}` });
    logProfileStage(args, { scope: "plugin", name: "cleanup_stream", stream: plan.idx, source_stream: plan.sourceIdx, wall_sec: cleanupStreamRes.wallSec });
    args.jobLog(`GPU Normalize Audio result: ${describePlan(plan)} completed.`);
    completedWork += plan.work;
    logProfileStage(args, { scope: "plugin", name: "per_stream_total", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: (Date.now() - streamStartedAt) / 1000 });
    updateProgress(completedWork, true);
  }
  }

  const muxRes = await runChecked(mux, {
    label: "mux normalized audio streams",
    parseLine: (line) => {
      const fraction = ffmpegProgressFraction(line, durationSeconds);
      if (fraction !== null) updateProgress(completedWork + muxWork * fraction);
    },
  });
  logProfileStage(args, { scope: "plugin", name: "final_mux", wall_sec: muxRes.wallSec });
  const verifyRes = await runChecked(`test -s ${q(tmpOutputFilePath)}`, { label: "verify GPU normalize output" });
  logProfileStage(args, { scope: "plugin", name: "verify_output", wall_sec: verifyRes.wallSec });
  const publishRes = await runChecked(`mv -f ${q(tmpOutputFilePath)} ${q(outputFilePath)}`, { label: "publish GPU normalize output" });
  logProfileStage(args, { scope: "plugin", name: "publish_output", wall_sec: publishRes.wallSec });
  const cleanupFinalRes = await runChecked(cleanupAll, { label: "cleanup GPU normalize intermediates" });
  logProfileStage(args, { scope: "plugin", name: "cleanup", wall_sec: cleanupFinalRes.wallSec });
  logProfileStage(args, { scope: "plugin", name: "whole_plugin", wall_sec: (Date.now() - pluginStartedAt) / 1000 });
  args.jobLog(`GPU Normalize Audio result: output contains ${audioPlans.length} normalized/generated audio stream(s) and ${skippedAudioPlans.length} copied unchanged audio stream(s).`);
  if (typeof args.updateWorker === "function") args.updateWorker({ percentage: 100, ETA: "0:00:00" });
  return { outputFileObj: { _id: outputFilePath }, outputNumber: 1, variables: args.variables };
  } catch (err) {
    cancelBackgroundCpu();
    await settleCpuLoudnormTasks();
    try {
      const cleanupFailedRes = await runShell(cleanupAll, { args, label: "cleanup failed GPU normalize outputs" });
      logProfileStage(args, { scope: "plugin", name: "cleanup_failed", wall_sec: cleanupFailedRes.wallSec, exit_code: cleanupFailedRes.code });
    } catch (cleanupErr) {
      args.jobLog(`GPU normalize cleanup after failure failed: ${cleanupErr.message}`);
    }
    throw err;
  } finally {
    releaseConcurrencyLock();
  }
};
exports.plugin = plugin;
