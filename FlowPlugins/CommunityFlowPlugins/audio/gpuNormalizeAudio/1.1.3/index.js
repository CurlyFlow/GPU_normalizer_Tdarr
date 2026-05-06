"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

const fs = require("fs");
const childProcess = require("child_process");

const PLUGIN_VERSION = "1.1.3";
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

function langTag(value) {
  const cleaned = String(value || "und").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
  return cleaned || "und";
}

function missingRuntime(label, path) {
  return new Error(`${label} not found: ${path}. Install the GPU loudnorm runtime bundle in the Tdarr container or set the plugin input to the correct path.`);
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
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.startsWith("tdarr_progress ") && !line.startsWith("frame=") && !line.startsWith("fps=") && !line.startsWith("out_time"))
    .join("\n");
}

function profileValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value.toFixed(6) : String(value);
  return String(value).replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.=:+-]/g, "_");
}

function logProfileStage(args, fields) {
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
  const startedAt = Date.now();
  args.jobLog(`Running ${opts.label}`);
  return new Promise((resolve) => {
    const outputChunks = [];
    let lineBuffer = "";
    const capture = capturePath ? fs.createWriteStream(capturePath, { flags: "w" }) : null;
    const proc = childProcess.spawn("/bin/bash", ["-lc", command], { stdio: ["ignore", "pipe", "pipe"] });
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
      if (capture) capture.end();
      args.jobLog(`Error running ${opts.label}: ${err.message}`);
      resolve({ code: 1, output: outputChunks.join(""), wallSec: (Date.now() - startedAt) / 1000 });
    });
    proc.on("close", (code) => {
      process.removeListener("exit", exitHandler);
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
    args.jobLog(`All ${maxConcurrent} GPU normalize slots busy; waiting 10s: ${base}.slotN.lockdir`);
    await sleep(10000);
  }
}

const details = () => ({
  name: "GPU Normalize Audio",
  description: "Normalize all audio streams with FFmpeg loudnorm-compatible planning and GPU-assisted rendering, then mux them back while preserving video, subtitle, attachment, data, chapters, and metadata.",
  style: { borderColor: "#38bdf8" },
  tags: "video,audio,normalize,loudnorm,gpu",
  isStartPlugin: false,
  pType: "",
  requiresVersion: "2.11.01",
  sidebarPosition: -1,
  icon: "faVolumeUp",
  inputs: [
    { label: "Planner Mode", name: "plannerMode", type: "string", defaultValue: "gpuSourcePort", inputUI: { type: "text" }, tooltip: "gpuSourcePort uses the CUDA source-port planner and apply path. sourceExact uses the source-core planner with GPU apply." },
    { label: "Source Core Path", name: "sourceCorePath", type: "string", defaultValue: `${RUNTIME_BIN}/loudnorm-source-cpu`, inputUI: { type: "text" }, tooltip: "Path to the FFmpeg-source loudnorm planning core inside the plugin runtime folder." },
    { label: "GPU Plan Core Path", name: "gpuPlanCorePath", type: "string", defaultValue: `${RUNTIME_BIN}/loudnorm-gpu-source-port`, inputUI: { type: "text" }, tooltip: "Path to the CUDA source-port loudness/gain planner inside the plugin runtime folder." },
    { label: "GPU Apply Path", name: "gpuApplyPath", type: "string", defaultValue: `${RUNTIME_BIN}/gpu-apply-sample-gains`, inputUI: { type: "text" }, tooltip: "Path to the CUDA per-sample gain renderer used by sourceExact mode, inside the plugin runtime folder." },
    { label: "GPU Chunk MiB", name: "gpuChunkMiB", type: "string", defaultValue: "64", inputUI: { type: "text" }, tooltip: "Input/gain/output chunk size used by the GPU runtime." },
    { label: "Integrated Loudness I", name: "i", type: "string", defaultValue: "-18.0", inputUI: { type: "text" }, tooltip: "FFmpeg loudnorm I target in LUFS." },
    { label: "Loudness Range LRA", name: "lra", type: "string", defaultValue: "7.0", inputUI: { type: "text" }, tooltip: "FFmpeg loudnorm LRA target in LU." },
    { label: "True Peak TP", name: "tp", type: "string", defaultValue: "-2.0", inputUI: { type: "text" }, tooltip: "FFmpeg loudnorm true-peak target in dBTP." },
    { label: "Max Gain dB", name: "maxGain", type: "string", defaultValue: "15", inputUI: { type: "text" }, tooltip: "Safety gate. If target I minus measured input_i exceeds this value, copy the original package instead of normalizing. Use 0 to disable." },
    { label: "PCM Sample Rate", name: "sampleRate", type: "string", defaultValue: "192000", inputUI: { type: "text" }, tooltip: "FFmpeg dynamic loudnorm uses 192000 Hz internally. Keep 192000 for parity." },
    { label: "AAC Output Sample Rate", name: "encodeSampleRate", type: "string", defaultValue: "", inputUI: { type: "text" }, tooltip: "Experimental. Empty means use PCM Sample Rate. Keep empty/192000 for parity." },
    { label: "PCM Channels", name: "channels", type: "string", defaultValue: "auto", inputUI: { type: "text" }, tooltip: "Use auto/source to match each audio stream channel count, or set a fixed channel count." },
    { label: "Enable 2-Channel Track", name: "ensureStereo", type: "string", defaultValue: "true", inputUI: { type: "text" }, tooltip: "Default true. If the normalized output would have no 2-channel audio track, add a normalized stereo downmix from the first audio stream. Set false to disable." },
    { label: "Require GPU Worker", name: "requireGpuWorker", type: "string", defaultValue: "true", inputUI: { type: "text" }, tooltip: "Fail fast if Tdarr schedules this plugin on a Transcode CPU worker. Set false only for direct/manual harness tests." },
    { label: "Max Concurrent Jobs", name: "maxConcurrentJobs", type: "string", defaultValue: "1", inputUI: { type: "text" }, tooltip: "Maximum concurrent GPU normalize jobs for this lock base. Set 0 to disable the guarded slot lock." },
    { label: "Lock File", name: "lockFile", type: "string", defaultValue: "/tmp/opx_tdarr_gpu_normalize.lock", inputUI: { type: "text" }, tooltip: "Base path for GPU normalize slot lock directories." },
    { label: "Audio Bitrate", name: "audioBitrate", type: "string", defaultValue: "192k", inputUI: { type: "text" }, tooltip: "AAC bitrate for normalized audio streams." },
    { label: "Max PCM MiB", name: "maxPcmMiB", type: "string", defaultValue: "65536", inputUI: { type: "text" }, tooltip: "Abort if a decoded raw audio stream exceeds this size." },
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
  args.inputs = lib.loadDefaultValues(args.inputs, details);

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
  const gpuChunkMiB = String(args.inputs.gpuChunkMiB || "64").trim();
  if (useGpuSourcePort) {
    if (!fs.existsSync(gpuPlanCorePath)) throw missingRuntime("GPU plan core", gpuPlanCorePath);
  } else {
    if (!fs.existsSync(sourceCorePath)) throw missingRuntime("Source core", sourceCorePath);
    if (!fs.existsSync(gpuApplyPath)) throw missingRuntime("GPU apply", gpuApplyPath);
  }

  const sampleRate = intNum(args.inputs.sampleRate, 192000);
  const encodeSampleRateInput = String(args.inputs.encodeSampleRate || "").trim();
  const encodeSampleRateArgs = encodeSampleRateInput ? ["-ar", String(intNum(encodeSampleRateInput, sampleRate))] : [];
  const maxPcmMiB = num(args.inputs.maxPcmMiB, 8192);
  const targetI = num(args.inputs.i, -18.0);
  const targetLra = num(args.inputs.lra, 7.0);
  const targetTp = num(args.inputs.tp, -2.0);
  const maxGain = num(args.inputs.maxGain, 15);
  const ensureStereo = boolInput(args.inputs.ensureStereo, true);
  const maxBytes = Math.floor(maxPcmMiB * 1024 * 1024);
  const audioBitrate = String(args.inputs.audioBitrate || "192k").replace(/[^0-9kKmM]/g, "") || "192k";
  const gpuInputFormat = useGpuSourcePort ? "f64le" : "f32le";
  const gpuInputExt = useGpuSourcePort ? "f64" : "f32";
  const gpuOutputFormat = useGpuSourcePort ? "f64le" : "f32le";
  const gpuOutputExt = useGpuSourcePort ? "f64" : "f32";
  const useStreamingSourcePort = useGpuSourcePort;
  const container = getContainer(args.inputFileObj._id);
  const workDir = getPluginWorkDir(args);
  const base = getFileName(args.inputFileObj._id);
  const outputFilePath = `${workDir}/${base}.${container}`;
  if (outputFilePath === args.inputFileObj._id) throw new Error(`GPU normalize output path equals input path: ${outputFilePath}`);
  const copyOriginal = [
    q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", q(args.inputFileObj._id),
    "-map", "0", "-map_chapters", "0", "-map_metadata", "0", "-c", "copy", q(outputFilePath),
  ].join(" ");

  const audioPlans = audioStreams.map((stream, idx) => {
    const streamChannels = channelCount(args.inputs.channels, stream, 2);
    const suffix = `a${idx}`;
    return {
      idx,
      sourceIdx: idx,
      channels: streamChannels,
      language: langTag((stream.tags || {}).language || stream.language || "und"),
      stereoFallback: false,
      rawInput: `${workDir}/${base}.gpu-normalize.${suffix}.input.${gpuInputExt}`,
      rawInputFormat: gpuInputFormat,
      gains: `${workDir}/${base}.gpu-normalize.${suffix}.gains.f32`,
      measureErr: `${workDir}/${base}.gpu-normalize.${suffix}.measure.err`,
      sourceErr: `${workDir}/${base}.gpu-normalize.${suffix}.source.err`,
      rawGpu: `${workDir}/${base}.gpu-normalize.${suffix}.output.${gpuOutputExt}`,
      rawGpuFormat: gpuOutputFormat,
      normalizedAudio: `${workDir}/${base}.gpu-normalized.${suffix}.m4a`,
      fifoInput: `${workDir}/${base}.gpu-normalize.${suffix}.stream-in.fifo`,
      fifoOutput: `${workDir}/${base}.gpu-normalize.${suffix}.stream-out.fifo`,
    };
  });
  if (ensureStereo && !audioPlans.some((plan) => plan.channels === 2)) {
    const stream = audioStreams[0];
    audioPlans.push({
      idx: audioPlans.length,
      sourceIdx: 0,
      channels: 2,
      language: langTag((stream.tags || {}).language || stream.language || "und"),
      stereoFallback: true,
      rawInput: `${workDir}/${base}.gpu-normalize.stereo.input.${gpuInputExt}`,
      rawInputFormat: gpuInputFormat,
      gains: `${workDir}/${base}.gpu-normalize.stereo.gains.f32`,
      measureErr: `${workDir}/${base}.gpu-normalize.stereo.measure.err`,
      sourceErr: `${workDir}/${base}.gpu-normalize.stereo.source.err`,
      rawGpu: `${workDir}/${base}.gpu-normalize.stereo.output.${gpuOutputExt}`,
      rawGpuFormat: gpuOutputFormat,
      normalizedAudio: `${workDir}/${base}.gpu-normalized.stereo.m4a`,
      fifoInput: `${workDir}/${base}.gpu-normalize.stereo.stream-in.fifo`,
      fifoOutput: `${workDir}/${base}.gpu-normalize.stereo.stream-out.fifo`,
    });
  }
  const durationSeconds = parseDurationSeconds(args.inputFileObj) || 1;
  for (const plan of audioPlans) {
    plan.work = Math.max(1, durationSeconds * plan.channels);
    plan.estimatedRawInputBytes = Math.ceil(durationSeconds * sampleRate * plan.channels * sampleBytes(plan.rawInputFormat));
    plan.estimatedRawOutputBytes = Math.ceil(durationSeconds * sampleRate * plan.channels * sampleBytes(plan.rawGpuFormat));
  }
  const audioWork = audioPlans.reduce((sum, plan) => sum + plan.work, 0);
  const muxWork = Math.max(1, audioWork * 0.03);
  const totalWork = audioWork + muxWork;
  const baselineEtaSeconds = Math.max(5, totalWork / 90);
  const updateProgress = createProgressUpdater(args, totalWork, baselineEtaSeconds);
  const allIntermediateFiles = audioPlans.flatMap((plan) => [plan.rawInput, plan.gains, plan.measureErr, plan.sourceErr, plan.rawGpu, plan.normalizedAudio, plan.fifoInput, plan.fifoOutput]);
  const cleanupAll = `rm -f ${allIntermediateFiles.map(q).join(" ")}`;

  const muxArgs = [q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", q(args.inputFileObj._id)];
  for (const plan of audioPlans) muxArgs.push("-i", q(plan.normalizedAudio));
  muxArgs.push("-map", "0:v?");
  audioPlans.forEach((_, idx) => muxArgs.push("-map", `${idx + 1}:a:0`));
  muxArgs.push("-map", "0:s?", "-map", "0:t?", "-map", "0:d?", "-map_chapters", "0", "-map_metadata", "0", "-c", "copy");
  audioPlans.forEach((plan, idx) => muxArgs.push(`-metadata:s:a:${idx}`, q(`language=${plan.language}`)));
  muxArgs.push(q(outputFilePath));
  const mux = muxArgs.join(" ");

  const runChecked = async (command, opts) => {
    const res = await runShell(command, { args, ...opts });
    if (!(opts.allowedCodes || [0]).includes(res.code)) throw new Error(`${opts.label} failed`);
    return res;
  };

  const copyOriginalPackage = async (reason, progressBase) => {
    args.jobLog(reason);
    const copyRes = await runChecked(copyOriginal, {
      label: "copy original package",
      parseLine: (line) => {
        const fraction = ffmpegProgressFraction(line, durationSeconds);
        if (fraction !== null) updateProgress(progressBase + (totalWork - progressBase) * fraction);
      },
    });
    logProfileStage(args, { scope: "plugin", name: "copy_original", wall_sec: copyRes.wallSec });
    const cleanupRes = await runChecked(cleanupAll, { label: "cleanup GPU normalize intermediates" });
    logProfileStage(args, { scope: "plugin", name: "cleanup", wall_sec: cleanupRes.wallSec });
    logProfileStage(args, { scope: "plugin", name: "whole_plugin", wall_sec: (Date.now() - pluginStartedAt) / 1000 });
    if (typeof args.updateWorker === "function") args.updateWorker({ percentage: 100, ETA: "0:00:00" });
    return { outputFileObj: { _id: outputFilePath }, outputNumber: 1, variables: args.variables };
  };

  args.jobLog(useGpuSourcePort
    ? "Running GPU normalize: FFmpeg decode -> CUDA loudness/gain plan+apply -> FFmpeg encode/mux"
    : "Running GPU normalize: FFmpeg decode -> source-core exact gains -> CUDA apply -> FFmpeg encode/mux");
  args.jobLog(`GPU normalize Tdarr worker: worker_type=${workerType || "unknown"} require_gpu_worker=${requireGpuWorker ? "true" : "false"}`);
  args.jobLog(`GPU normalize audio streams: count=${audioPlans.length} channel_input=${String(args.inputs.channels || "auto")} effective_channels=${audioPlans.map((plan) => plan.channels).join(",")} ensure_stereo=${ensureStereo ? "true" : "false"}`);
  for (const plan of audioPlans) {
    args.jobLog(`GPU normalize ${plan.sourceIdx}${plan.stereoFallback ? " stereo fallback" : ""}: estimated_raw_input_mib=${(plan.estimatedRawInputBytes / (1024 * 1024)).toFixed(1)} estimated_raw_output_mib=${(plan.estimatedRawOutputBytes / (1024 * 1024)).toFixed(1)} max_pcm_mib=${maxPcmMiB.toFixed(1)} streaming_io=${useStreamingSourcePort ? "true" : "false"}`);
    if (!useStreamingSourcePort && plan.estimatedRawInputBytes > maxBytes) {
      throw new Error(`GPU normalize PCM guard would be exceeded on audio stream ${plan.sourceIdx}: estimated_bytes=${plan.estimatedRawInputBytes} max=${maxBytes}`);
    }
  }

  const releaseConcurrencyLock = await acquireConcurrencyLock(args, args.inputs.lockFile, args.inputs.maxConcurrentJobs);
  try {
  const cleanupPreviousRes = await runChecked(`${cleanupAll}; rm -f ${q(outputFilePath)}`, { label: "cleanup previous GPU normalize outputs" });
  logProfileStage(args, { scope: "plugin", name: "cleanup_previous", wall_sec: cleanupPreviousRes.wallSec });
  let completedWork = 0;
  updateProgress(0, true);
  for (const plan of audioPlans) {
    const streamStartedAt = Date.now();
    const planLabel = `audio stream ${plan.sourceIdx}${plan.stereoFallback ? " stereo fallback" : ""}`;
    args.jobLog(`GPU normalize ${planLabel}: channels=${plan.channels} language=${plan.language}`);
    const measureSpan = useGpuSourcePort ? plan.work * 0.18 : 0;
    const decodeSpan = plan.work * 0.08;
    const normalizeSpan = plan.work * (useGpuSourcePort ? 0.54 : 0.72);
    const encodeSpan = plan.work * 0.2;
    let cpuLoudnormValues = null;
    if (useGpuSourcePort) {
      const cachedValues = cachedCpuLoudnorm(args, plan.sourceIdx);
      let measureWallSec = 0;
      if (cachedValues) {
        cpuLoudnormValues = cachedValues;
        args.jobLog(`GPU normalize using cached CPU loudnorm first pass ${planLabel}: ${JSON.stringify(cpuLoudnormValues)}`);
      } else {
        const measure = [
          q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", q(args.inputFileObj._id),
          "-map", `0:a:${plan.sourceIdx}`, "-vn", "-sn", "-dn",
          "-af", q(`loudnorm=I=${targetI}:LRA=${targetLra}:TP=${targetTp}:print_format=json`),
          "-f", "null", (args.platform === "win32" ? "NUL" : "/dev/null"),
        ].join(" ");
        const measureRes = await runChecked(measure, {
          label: `CPU loudnorm first pass ${planLabel}`,
          capturePath: plan.measureErr,
          logOnSuccess: true,
          parseLine: (line) => {
            const fraction = ffmpegProgressFraction(line, durationSeconds);
            if (fraction !== null) updateProgress(completedWork + measureSpan * fraction);
          },
        });
        measureWallSec = measureRes.wallSec;
        cpuLoudnormValues = parseLoudnormJson(measureRes.output);
        args.jobLog(`GPU normalize CPU loudnorm first pass ${planLabel}: ${JSON.stringify(cpuLoudnormValues)}`);
      }
      const inputI = loudnormNumber(cpuLoudnormValues, "input_i");
      const gainNeeded = targetI - inputI;
      args.jobLog(`GPU normalize gain_needed=${gainNeeded.toFixed(2)} LU max_gain=${maxGain.toFixed(2)} LU`);
      logProfileStage(args, { scope: "plugin", name: "cpu_loudnorm_first_pass", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: measureWallSec, cached: cachedValues ? 1 : 0 });
      updateProgress(completedWork + measureSpan, true);
      if (maxGain > 0 && gainNeeded > maxGain) {
        return await copyOriginalPackage(`GPU normalize gain gate exceeded on ${planLabel}; copying original package`, completedWork + measureSpan);
      }
    }
    if (useStreamingSourcePort) {
      const decodeCommand = [
        String(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", String(args.inputFileObj._id),
        "-map", `0:a:${plan.sourceIdx}`, "-vn", "-sn", "-dn", "-ac", String(plan.channels), "-ar", String(sampleRate), "-f", plan.rawInputFormat, "pipe:1",
      ];
      const encodeCommand = [
        String(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-f", plan.rawGpuFormat, "-ac", String(plan.channels), "-ar", String(sampleRate),
        "-i", "pipe:0", ...encodeSampleRateArgs, "-c:a", "aac", "-b:a", audioBitrate, plan.normalizedAudio,
      ];
      const gpuPlan = [
        q(gpuPlanCorePath), "-", "-",
        "--rate", String(sampleRate), "--channels", String(plan.channels),
        "--target-i", String(targetI), "--target-lra", String(targetLra), "--target-tp", String(targetTp),
        "--max-gain-db", String(maxGain), "--chunk-mib", q(gpuChunkMiB), "--max-pcm-mib", String(maxPcmMiB),
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
      ].join(" ");
      const gpuRes = await runShell(gpuPlan, {
        args,
        label: `GPU streaming normalize ${planLabel}`,
        allowedCodes: [0, 42],
        capturePath: plan.sourceErr,
        logOnSuccess: true,
        parseLine: (line) => {
          const fraction = gpuProgressFraction(line);
          if (fraction !== null) updateProgress(completedWork + measureSpan + decodeSpan + normalizeSpan * fraction);
        },
      });
      logProfileStage(args, { scope: "plugin", name: "gpu_source_port_streaming", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: gpuRes.wallSec });
      if (gpuRes.code === 42) {
        return await copyOriginalPackage(`GPU normalize gain gate exceeded on ${planLabel}; copying original package`, completedWork + measureSpan + decodeSpan + normalizeSpan);
      }
      if (gpuRes.code !== 0) throw new Error(`GPU streaming normalize failed on ${planLabel}`);
      updateProgress(completedWork + measureSpan + decodeSpan + normalizeSpan + encodeSpan, true);
      const cleanupRaw = `rm -f ${[plan.rawInput, plan.gains, plan.measureErr, plan.sourceErr, plan.rawGpu, plan.fifoInput, plan.fifoOutput].map(q).join(" ")}`;
      const cleanupStreamRes = await runChecked(cleanupRaw, { label: `cleanup ${planLabel}` });
      logProfileStage(args, { scope: "plugin", name: "cleanup_stream", stream: plan.idx, source_stream: plan.sourceIdx, wall_sec: cleanupStreamRes.wallSec });
      completedWork += plan.work;
      logProfileStage(args, { scope: "plugin", name: "per_stream_total", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: (Date.now() - streamStartedAt) / 1000 });
      updateProgress(completedWork, true);
      continue;
    }

    const decode = [
      q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-i", q(args.inputFileObj._id),
      "-map", `0:a:${plan.sourceIdx}`, "-vn", "-sn", "-dn", "-ac", String(plan.channels), "-ar", String(sampleRate), "-f", q(plan.rawInputFormat), q(plan.rawInput),
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
    if (decodedBytes > maxBytes) throw new Error(`GPU normalize PCM guard exceeded on audio stream ${plan.sourceIdx}: bytes=${decodedBytes} max=${maxBytes}`);
    args.jobLog(`GPU normalize ${planLabel}: raw_pcm_bytes=${decodedBytes} raw_pcm_mib=${(decodedBytes / (1024 * 1024)).toFixed(1)}`);
    logProfileStage(args, { scope: "plugin", name: "ffmpeg_decode", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: decodeRes.wallSec, raw_mib: decodedBytes / (1024 * 1024) });

    if (useGpuSourcePort) {
      const gpuPlan = [
        q(gpuPlanCorePath), q(plan.rawInput), q(plan.rawGpu),
        "--rate", String(sampleRate), "--channels", String(plan.channels),
        "--target-i", String(targetI), "--target-lra", String(targetLra), "--target-tp", String(targetTp),
        "--max-gain-db", String(maxGain), "--chunk-mib", q(gpuChunkMiB), "--max-pcm-mib", String(maxPcmMiB),
        "--measured-i", String(loudnormNumber(cpuLoudnormValues, "input_i")),
        "--measured-lra", String(loudnormNumber(cpuLoudnormValues, "input_lra")),
        "--measured-tp", String(loudnormNumber(cpuLoudnormValues, "input_tp")),
        "--measured-thresh", String(loudnormNumber(cpuLoudnormValues, "input_thresh")),
        "--offset-db", String(loudnormNumber(cpuLoudnormValues, "target_offset")), "--ffmpeg-linear", "--disable-short-source-exact", "--ffmpeg-limiter", "--ffmpeg-gain-offset-ms", "210",
        "--input-format", q(plan.rawInputFormat),
        "--output-format", q(plan.rawGpuFormat),
        "--ptx-path", q(`${RUNTIME_CUDA}/loudnorm_source_port_kernels.ptx`), "--source-core-path", q(sourceCorePath),
      ].join(" ");
      const gpuRes = await runShell(gpuPlan, {
        args,
        label: `GPU normalize ${planLabel}`,
        allowedCodes: [0, 42],
        capturePath: plan.sourceErr,
        logOnSuccess: true,
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
        logOnSuccess: true,
      });
      logProfileStage(args, { scope: "plugin", name: "source_core_gains", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: sourceRes.wallSec });
      const inputMatch = sourceRes.output.match(/input_i=([-+0-9.]+)/);
      if (maxGain > 0) {
        if (!inputMatch) throw new Error("GPU normalize: missing input_i in source metrics");
        const gainNeeded = targetI - Number.parseFloat(inputMatch[1]);
        args.jobLog(`GPU normalize gain_needed=${gainNeeded.toFixed(2)} LU max_gain=${maxGain.toFixed(2)} LU`);
        if (gainNeeded > maxGain) {
          return await copyOriginalPackage(`GPU normalize gain gate exceeded on ${planLabel}; copying original package`, completedWork + decodeSpan + normalizeSpan);
        }
      }
      const apply = [q(gpuApplyPath), q(plan.rawInput), q(plan.gains), q(plan.rawGpu), "--chunk-mib", q(gpuChunkMiB)].join(" ");
      updateProgress(completedWork + decodeSpan + normalizeSpan * 0.65, true);
      const applyRes = await runChecked(apply, { label: `GPU apply ${planLabel}`, logOnSuccess: true });
      logProfileStage(args, { scope: "plugin", name: "gpu_apply", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: applyRes.wallSec });
    }
    updateProgress(completedWork + measureSpan + decodeSpan + normalizeSpan, true);

    const encode = [
      q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-progress", "pipe:2", "-y", "-f", q(plan.rawGpuFormat), "-ac", String(plan.channels), "-ar", String(sampleRate),
      "-i", q(plan.rawGpu), ...encodeSampleRateArgs, "-c:a", "aac", "-b:a", q(audioBitrate), q(plan.normalizedAudio),
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
    completedWork += plan.work;
    logProfileStage(args, { scope: "plugin", name: "per_stream_total", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: (Date.now() - streamStartedAt) / 1000 });
    updateProgress(completedWork, true);
  }

  const muxRes = await runChecked(mux, {
    label: "mux normalized audio streams",
    parseLine: (line) => {
      const fraction = ffmpegProgressFraction(line, durationSeconds);
      if (fraction !== null) updateProgress(completedWork + muxWork * fraction);
    },
  });
  logProfileStage(args, { scope: "plugin", name: "final_mux", wall_sec: muxRes.wallSec });
  const verifyRes = await runChecked(`test -s ${q(outputFilePath)}`, { label: "verify GPU normalize output" });
  logProfileStage(args, { scope: "plugin", name: "verify_output", wall_sec: verifyRes.wallSec });
  const cleanupFinalRes = await runChecked(cleanupAll, { label: "cleanup GPU normalize intermediates" });
  logProfileStage(args, { scope: "plugin", name: "cleanup", wall_sec: cleanupFinalRes.wallSec });
  logProfileStage(args, { scope: "plugin", name: "whole_plugin", wall_sec: (Date.now() - pluginStartedAt) / 1000 });
  if (typeof args.updateWorker === "function") args.updateWorker({ percentage: 100, ETA: "0:00:00" });
  return { outputFileObj: { _id: outputFilePath }, outputNumber: 1, variables: args.variables };
  } catch (err) {
    try {
      const cleanupFailedRes = await runShell(`${cleanupAll}; rm -f ${q(outputFilePath)}`, { args, label: "cleanup failed GPU normalize outputs" });
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
