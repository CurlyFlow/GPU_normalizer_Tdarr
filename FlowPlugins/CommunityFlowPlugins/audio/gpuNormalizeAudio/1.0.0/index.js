"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

const fs = require("fs");

const PLUGIN_ROOT = "/app/server/Tdarr/Plugins/FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.0.0";
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
  const { CLI } = requireAny([
    "../../../../FlowHelpers/1.0.0/cliUtils",
    "../../../FlowHelpers/1.0.0/cliUtils",
  ]);
  const { getContainer, getFileName, getPluginWorkDir } = requireAny([
    "../../../../FlowHelpers/1.0.0/fileUtils",
    "../../../FlowHelpers/1.0.0/fileUtils",
  ]);
  return { CLI, getContainer, getFileName, getPluginWorkDir };
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

function writeRunner(workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const runnerPath = `${workDir}/gpu-normalize-runner.sh`;
  fs.writeFileSync(runnerPath, "#!/bin/sh\nexec /bin/bash -lc \"$1\"\n", { mode: 0o755 });
  fs.chmodSync(runnerPath, 0o755);
  return runnerPath;
}

function missingRuntime(label, path) {
  return new Error(`${label} not found: ${path}. Install the GPU loudnorm runtime bundle in the Tdarr container or set the plugin input to the correct path.`);
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
    { label: "Planner Mode", name: "plannerMode", type: "string", defaultValue: "sourceExact", inputUI: { type: "text" }, tooltip: "sourceExact uses the exact source-core planner with GPU apply. gpuSourcePort uses the CUDA source-port planner and apply path." },
    { label: "Source Core Path", name: "sourceCorePath", type: "string", defaultValue: `${RUNTIME_BIN}/loudnorm-source-cpu`, inputUI: { type: "text" }, tooltip: "Path to the FFmpeg-source loudnorm planning core inside the plugin runtime folder." },
    { label: "GPU Plan Core Path", name: "gpuPlanCorePath", type: "string", defaultValue: `${RUNTIME_BIN}/loudnorm-gpu-source-port`, inputUI: { type: "text" }, tooltip: "Path to the CUDA source-port loudness/gain planner inside the plugin runtime folder." },
    { label: "GPU Apply Path", name: "gpuApplyPath", type: "string", defaultValue: `${RUNTIME_BIN}/gpu-apply-sample-gains`, inputUI: { type: "text" }, tooltip: "Path to the CUDA per-sample gain renderer used by sourceExact mode, inside the plugin runtime folder." },
    { label: "GPU Chunk MiB", name: "gpuChunkMiB", type: "string", defaultValue: "64", inputUI: { type: "text" }, tooltip: "Input/gain/output chunk size used by the GPU runtime." },
    { label: "Integrated Loudness I", name: "i", type: "string", defaultValue: "-18.0", inputUI: { type: "text" }, tooltip: "FFmpeg loudnorm I target in LUFS." },
    { label: "Loudness Range LRA", name: "lra", type: "string", defaultValue: "7.0", inputUI: { type: "text" }, tooltip: "FFmpeg loudnorm LRA target in LU." },
    { label: "True Peak TP", name: "tp", type: "string", defaultValue: "-2.0", inputUI: { type: "text" }, tooltip: "FFmpeg loudnorm true-peak target in dBTP." },
    { label: "Max Gain dB", name: "maxGain", type: "string", defaultValue: "15", inputUI: { type: "text" }, tooltip: "Safety gate. If target I minus measured input_i exceeds this value, copy the original package instead of normalizing. Use 0 to disable." },
    { label: "PCM Sample Rate", name: "sampleRate", type: "string", defaultValue: "192000", inputUI: { type: "text" }, tooltip: "FFmpeg dynamic loudnorm uses 192000 Hz internally. Keep 192000 for parity." },
    { label: "PCM Channels", name: "channels", type: "string", defaultValue: "auto", inputUI: { type: "text" }, tooltip: "Use auto/source to match each audio stream channel count, or set a fixed channel count." },
    { label: "Ensure Stereo Track", name: "ensureStereo", type: "string", defaultValue: "true", inputUI: { type: "text" }, tooltip: "Migz-style behavior: if the normalized output would have no 2-channel audio track, add a normalized stereo downmix from the first audio stream. Set false to disable." },
    { label: "Audio Bitrate", name: "audioBitrate", type: "string", defaultValue: "192k", inputUI: { type: "text" }, tooltip: "AAC bitrate for normalized audio streams." },
    { label: "Max PCM MiB", name: "maxPcmMiB", type: "string", defaultValue: "65536", inputUI: { type: "text" }, tooltip: "Abort if a decoded raw audio stream exceeds this size." },
  ],
  outputs: [
    { number: 1, tooltip: "Normalized audio streams muxed back into the original package" },
  ],
});
exports.details = details;

const plugin = async (args) => {
  const lib = loadTdarrLib();
  const { CLI, getContainer, getFileName, getPluginWorkDir } = loadFlowHelpers();
  args.inputs = lib.loadDefaultValues(args.inputs, details);

  const streams = (((args.inputFileObj || {}).ffProbeData || {}).streams || []);
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
  if (audioStreams.length === 0) {
    args.jobLog("No audio streams found; skipping GPU normalize.");
    return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
  }

  const plannerMode = String(args.inputs.plannerMode || "sourceExact").trim();
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
  const maxPcmMiB = num(args.inputs.maxPcmMiB, 8192);
  const targetI = num(args.inputs.i, -18.0);
  const targetLra = num(args.inputs.lra, 7.0);
  const targetTp = num(args.inputs.tp, -2.0);
  const maxGain = num(args.inputs.maxGain, 15);
  const ensureStereo = boolInput(args.inputs.ensureStereo, true);
  const maxBytes = Math.floor(maxPcmMiB * 1024 * 1024);
  const audioBitrate = String(args.inputs.audioBitrate || "192k").replace(/[^0-9kKmM]/g, "") || "192k";
  const container = getContainer(args.inputFileObj._id);
  const workDir = getPluginWorkDir(args);
  const base = getFileName(args.inputFileObj._id);
  const outputFilePath = `${workDir}/${base}.gpu-normalized.${container}`;
  const maxGainPython = [
    "import re, sys",
    "path=sys.argv[1]; target_i=float(sys.argv[2]); max_gain=float(sys.argv[3])",
    "text=open(path, 'r', errors='ignore').read()",
    "m=re.search(r'input_i=([-+0-9.]+)', text)",
    "if not m: print('GPU normalize: missing input_i in source metrics', file=sys.stderr); raise SystemExit(43)",
    "input_i=float(m.group(1)); gain_needed=target_i-input_i",
    "print(f'GPU normalize gain_needed={gain_needed:.2f} LU max_gain={max_gain:.2f} LU', file=sys.stderr)",
    "raise SystemExit(0 if gain_needed <= max_gain else 42)",
  ].join("\n");
  const copyOriginal = [
    q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-y", "-i", q(args.inputFileObj._id),
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
      rawInput: `${workDir}/${base}.gpu-normalize.${suffix}.input.f32`,
      gains: `${workDir}/${base}.gpu-normalize.${suffix}.gains.f32`,
      sourceErr: `${workDir}/${base}.gpu-normalize.${suffix}.source.err`,
      rawGpu: `${workDir}/${base}.gpu-normalize.${suffix}.output.f32`,
      normalizedAudio: `${workDir}/${base}.gpu-normalized.${suffix}.m4a`,
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
      rawInput: `${workDir}/${base}.gpu-normalize.stereo.input.f32`,
      gains: `${workDir}/${base}.gpu-normalize.stereo.gains.f32`,
      sourceErr: `${workDir}/${base}.gpu-normalize.stereo.source.err`,
      rawGpu: `${workDir}/${base}.gpu-normalize.stereo.output.f32`,
      normalizedAudio: `${workDir}/${base}.gpu-normalized.stereo.m4a`,
    });
  }
  const allIntermediateFiles = audioPlans.flatMap((plan) => [plan.rawInput, plan.gains, plan.sourceErr, plan.rawGpu, plan.normalizedAudio]);
  const cleanupAll = `rm -f ${allIntermediateFiles.map(q).join(" ")}`;
  const perAudioScripts = [];
  for (const plan of audioPlans) {
    const decode = [
      q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-y", "-i", q(args.inputFileObj._id),
      "-map", `0:a:${plan.sourceIdx}`, "-vn", "-sn", "-dn", "-ac", String(plan.channels), "-ar", String(sampleRate), "-f", "f32le", q(plan.rawInput),
    ].join(" ");
    const source = [q(sourceCorePath), "--stream", q(plan.rawInput), "-", String(sampleRate), String(plan.channels), q(plan.gains), String(targetI), String(targetLra), String(targetTp), "2>", q(plan.sourceErr)].join(" ");
    const gpuPlan = [
      q(gpuPlanCorePath), q(plan.rawInput), q(plan.rawGpu),
      "--rate", String(sampleRate), "--channels", String(plan.channels),
      "--target-i", String(targetI), "--target-lra", String(targetLra), "--target-tp", String(targetTp),
      "--max-gain-db", String(maxGain), "--chunk-mib", q(gpuChunkMiB), "--max-pcm-mib", String(maxPcmMiB),
      "--ptx-path", q(`${RUNTIME_CUDA}/loudnorm_source_port_kernels.ptx`), "--source-core-path", q(sourceCorePath),
      "2>", q(plan.sourceErr),
    ].join(" ");
    const sourceGate = maxGain > 0 ? ["python3", "-c", q(maxGainPython), q(plan.sourceErr), String(targetI), String(maxGain)].join(" ") : "true";
    const apply = [q(gpuApplyPath), q(plan.rawInput), q(plan.gains), q(plan.rawGpu), "--chunk-mib", q(gpuChunkMiB)].join(" ");
    const encode = [
      q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-y", "-f", "f32le", "-ac", String(plan.channels), "-ar", String(sampleRate),
      "-i", q(plan.rawGpu), "-c:a", "aac", "-b:a", q(audioBitrate), q(plan.normalizedAudio),
    ].join(" ");
    const cleanupRaw = `rm -f ${[plan.rawInput, plan.gains, plan.sourceErr, plan.rawGpu].map(q).join(" ")}`;
    const sourceExactScript = [
      source,
      `cat ${q(plan.sourceErr)} >&2`,
      `if ! ${sourceGate}; then echo 'GPU normalize gain gate exceeded on audio stream ${plan.idx}; copying original package'; ${copyOriginal}; ${cleanupAll}; exit 0; fi`,
      apply,
    ];
    const gpuPlanScript = [
      "set +e",
      gpuPlan,
      "gpu_rc=$?",
      "set -e",
      `cat ${q(plan.sourceErr)} >&2`,
      `if [ "$gpu_rc" -eq 42 ]; then echo 'GPU normalize gain gate exceeded on audio stream ${plan.idx}; copying original package'; ${copyOriginal}; ${cleanupAll}; exit 0; fi`,
      `test "$gpu_rc" -eq 0`,
    ];
    perAudioScripts.push(
      `echo 'GPU normalize audio stream ${plan.sourceIdx}${plan.stereoFallback ? " stereo fallback" : ""}: channels=${plan.channels} language=${plan.language}' >&2`,
      decode,
      `bytes=$(wc -c < ${q(plan.rawInput)}); if [ "$bytes" -gt ${maxBytes} ]; then echo 'GPU normalize PCM guard exceeded on audio stream ${plan.sourceIdx}: bytes='"$bytes"' max=${maxBytes}' >&2; exit 1; fi`,
      ...(useGpuSourcePort ? gpuPlanScript : sourceExactScript),
      encode,
      cleanupRaw,
    );
  }

  const muxArgs = [q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-y", "-i", q(args.inputFileObj._id)];
  for (const plan of audioPlans) muxArgs.push("-i", q(plan.normalizedAudio));
  muxArgs.push("-map", "0:v?");
  audioPlans.forEach((_, idx) => muxArgs.push("-map", `${idx + 1}:a:0`));
  muxArgs.push("-map", "0:s?", "-map", "0:t?", "-map", "0:d?", "-map_chapters", "0", "-map_metadata", "0", "-c", "copy");
  audioPlans.forEach((plan, idx) => muxArgs.push(`-metadata:s:a:${idx}`, q(`language=${plan.language}`)));
  muxArgs.push(q(outputFilePath));
  const mux = muxArgs.join(" ");

  const script = [
    "set -euo pipefail",
    `${cleanupAll}; rm -f ${q(outputFilePath)}`,
    ...perAudioScripts,
    mux,
    `test -s ${q(outputFilePath)}`,
    cleanupAll,
  ].join("; ");

  args.jobLog(useGpuSourcePort
    ? "Running GPU normalize: FFmpeg decode -> CUDA loudness/gain plan+apply -> FFmpeg encode/mux"
    : "Running GPU normalize: FFmpeg decode -> source-core exact gains -> CUDA apply -> FFmpeg encode/mux");
  args.jobLog(`GPU normalize audio streams: count=${audioPlans.length} channel_input=${String(args.inputs.channels || "auto")} effective_channels=${audioPlans.map((plan) => plan.channels).join(",")} ensure_stereo=${ensureStereo ? "true" : "false"}`);
  const cli = new CLI({
    cli: writeRunner(workDir),
    spawnArgs: [script],
    spawnOpts: {},
    jobLog: args.jobLog,
    outputFilePath,
    inputFileObj: args.inputFileObj,
    logFullCliOutput: args.logFullCliOutput,
    updateWorker: args.updateWorker,
    args,
  });
  const res = await cli.runCli();
  if (res.cliExitCode !== 0) throw new Error("GPU normalize failed");
  return { outputFileObj: { _id: outputFilePath }, outputNumber: 1, variables: args.variables };
};
exports.plugin = plugin;
