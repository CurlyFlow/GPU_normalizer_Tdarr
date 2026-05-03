"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

const fs = require("fs");

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

function num(value, fallback) {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function langTag(value) {
  const cleaned = String(value || "und").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
  return cleaned || "und";
}

function writeRunner(workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const runnerPath = `${workDir}/opx-ffmpeg-gpu-exact-normalize-runner.sh`;
  fs.writeFileSync(runnerPath, "#!/bin/sh\nexec /bin/bash -lc \"$1\"\n", { mode: 0o755 });
  fs.chmodSync(runnerPath, 0o755);
  return runnerPath;
}

const details = () => ({
  name: "OPX GPU Normalize Exact Dev",
  description: "DEV ONLY: FFmpeg-source loudnorm oracle emits exact gains, CUDA renders the normalized PCM, then FFmpeg encodes/muxes it back.",
  style: { borderColor: "#f59e0b" },
  tags: "video,audio,opx,gpu,dev",
  isStartPlugin: false,
  pType: "",
  requiresVersion: "2.11.01",
  sidebarPosition: -1,
  icon: "faFlask",
  inputs: [
    { label: "Planner Mode", name: "plannerMode", type: "string", defaultValue: "sourceExact", inputUI: { type: "text" }, tooltip: "sourceExact keeps FFmpeg-source parity. gpuSourcePort uses the canary CUDA FFmpeg-source-port planner." },
    { label: "Source Core Path", name: "sourceCorePath", type: "string", defaultValue: "/app/server/opx/bin/opx-loudnorm-source-cpu.plugin-dev", inputUI: { type: "text" }, tooltip: "Standalone FFmpeg-source loudnorm core inside tdarr-dev." },
    { label: "GPU Plan Core Path", name: "gpuPlanCorePath", type: "string", defaultValue: "/app/server/opx/bin/opx-loudnorm-gpu-source-port", inputUI: { type: "text" }, tooltip: "Canary CUDA FFmpeg-source-port loudness/gain planner inside tdarr-dev." },
    { label: "GPU Apply Path", name: "gpuApplyPath", type: "string", defaultValue: "/app/server/opx/bin/opx-gpu-apply-sample-gains", inputUI: { type: "text" }, tooltip: "CUDA per-sample gain renderer inside tdarr-dev." },
    { label: "GPU Chunk MiB", name: "gpuChunkMiB", type: "string", defaultValue: "64", inputUI: { type: "text" }, tooltip: "Input/gain/output chunk size for CUDA apply. 64 MiB is fastest on GTX 1050 Ti in tdarr-dev tests." },
    { label: "Integrated Loudness I", name: "i", type: "string", defaultValue: "-18.0", inputUI: { type: "text" }, tooltip: "FFmpeg loudnorm I target in LUFS." },
    { label: "Loudness Range LRA", name: "lra", type: "string", defaultValue: "7.0", inputUI: { type: "text" }, tooltip: "FFmpeg loudnorm LRA target in LU." },
    { label: "True Peak TP", name: "tp", type: "string", defaultValue: "-2.0", inputUI: { type: "text" }, tooltip: "FFmpeg loudnorm true-peak target in dBTP." },
    { label: "Max Gain dB", name: "maxGain", type: "string", defaultValue: "15", inputUI: { type: "text" }, tooltip: "Safety gate. If exact gain exceeds this value, copy original stream package instead of normalizing. Use 0 to disable." },
    { label: "PCM Sample Rate", name: "sampleRate", type: "string", defaultValue: "192000", inputUI: { type: "text" }, tooltip: "FFmpeg dynamic loudnorm uses 192000 Hz internally. Keep 192000 for parity." },
    { label: "PCM Channels", name: "channels", type: "string", defaultValue: "2", inputUI: { type: "text" }, tooltip: "Output channels for normalized primary audio." },
    { label: "Audio Bitrate", name: "audioBitrate", type: "string", defaultValue: "192k", inputUI: { type: "text" }, tooltip: "AAC bitrate for normalized audio." },
    { label: "Max PCM MiB", name: "maxPcmMiB", type: "string", defaultValue: "8192", inputUI: { type: "text" }, tooltip: "Abort if decoded raw PCM exceeds this size." },
  ],
  outputs: [
    { number: 1, tooltip: "Exact GPU-rendered normalized first audio stream muxed back" },
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
    args.jobLog("No audio streams found; skipping OPX GPU exact normalize.");
    return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
  }

  const plannerMode = String(args.inputs.plannerMode || "sourceExact").trim();
  const useGpuSourcePort = plannerMode === "gpuSourcePort";
  const sourceCorePath = String(args.inputs.sourceCorePath || "/app/server/opx/bin/opx-loudnorm-source-cpu.plugin-dev").trim();
  const gpuPlanCorePath = String(args.inputs.gpuPlanCorePath || "/app/server/opx/bin/opx-loudnorm-gpu-source-port").trim();
  const gpuApplyPath = String(args.inputs.gpuApplyPath || "/app/server/opx/bin/opx-gpu-apply-sample-gains").trim();
  const gpuChunkMiB = String(args.inputs.gpuChunkMiB || "64").trim();
  if (useGpuSourcePort) {
    if (!fs.existsSync(gpuPlanCorePath)) throw new Error(`OPX GPU plan core not found: ${gpuPlanCorePath}`);
  } else {
    if (!fs.existsSync(sourceCorePath)) throw new Error(`OPX source core not found: ${sourceCorePath}`);
    if (!fs.existsSync(gpuApplyPath)) throw new Error(`OPX GPU apply not found: ${gpuApplyPath}`);
  }

  const sampleRate = intNum(args.inputs.sampleRate, 192000);
  const channels = intNum(args.inputs.channels, 2);
  const maxPcmMiB = num(args.inputs.maxPcmMiB, 8192);
  const targetI = num(args.inputs.i, -18.0);
  const targetLra = num(args.inputs.lra, 7.0);
  const targetTp = num(args.inputs.tp, -2.0);
  const maxGain = num(args.inputs.maxGain, 15);
  const maxBytes = Math.floor(maxPcmMiB * 1024 * 1024);
  const audioBitrate = String(args.inputs.audioBitrate || "192k").replace(/[^0-9kKmM]/g, "") || "192k";
  const language = langTag((audioStreams[0].tags || {}).language || audioStreams[0].language || "und");
  const container = getContainer(args.inputFileObj._id);
  const workDir = getPluginWorkDir(args);
  const base = getFileName(args.inputFileObj._id);
  const rawInput = `${workDir}/${base}.opx-exact.input.f32`;
  const gains = `${workDir}/${base}.opx-exact.gains.f32`;
  const sourceErr = `${workDir}/${base}.opx-exact.source.err`;
  const rawGpu = `${workDir}/${base}.opx-exact.gpu.f32`;
  const normalizedAudio = `${workDir}/${base}.opx-exact-normalized.m4a`;
  const outputFilePath = `${workDir}/${base}.opx-exact-normalized.${container}`;

  const decode = [
    q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-y", "-i", q(args.inputFileObj._id),
    "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", String(channels), "-ar", String(sampleRate), "-f", "f32le", q(rawInput),
  ].join(" ");
  const source = [q(sourceCorePath), "--stream", q(rawInput), "-", String(sampleRate), String(channels), q(gains), String(targetI), String(targetLra), String(targetTp), "2>", q(sourceErr)].join(" ");
  const gpuPlan = [
    q(gpuPlanCorePath), q(rawInput), q(rawGpu),
    "--rate", String(sampleRate), "--channels", String(channels),
    "--target-i", String(targetI), "--target-lra", String(targetLra), "--target-tp", String(targetTp),
    "--max-gain-db", String(maxGain), "--chunk-mib", q(gpuChunkMiB), "--max-pcm-mib", String(maxPcmMiB),
    "2>", q(sourceErr),
  ].join(" ");
  const maxGainPython = [
    "import re, sys",
    "path=sys.argv[1]; target_i=float(sys.argv[2]); max_gain=float(sys.argv[3])",
    "text=open(path, 'r', errors='ignore').read()",
    "m=re.search(r'input_i=([-+0-9.]+)', text)",
    "if not m: print('OPX exact normalize: missing input_i in source metrics', file=sys.stderr); raise SystemExit(43)",
    "input_i=float(m.group(1)); gain_needed=target_i-input_i",
    "print(f'OPX exact normalize gain_needed={gain_needed:.2f} LU max_gain={max_gain:.2f} LU', file=sys.stderr)",
    "raise SystemExit(0 if gain_needed <= max_gain else 42)",
  ].join("\n");
  const maxGainGate = maxGain > 0 ? ["python3", "-c", q(maxGainPython), q(sourceErr), String(targetI), String(maxGain)].join(" ") : "true";
  const copyOriginal = [
    q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-y", "-i", q(args.inputFileObj._id),
    "-map", "0", "-map_chapters", "0", "-map_metadata", "0", "-c", "copy", q(outputFilePath),
  ].join(" ");
  const apply = [q(gpuApplyPath), q(rawInput), q(gains), q(rawGpu), "--chunk-mib", q(gpuChunkMiB)].join(" ");
  const encode = [
    q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-y", "-f", "f32le", "-ac", String(channels), "-ar", String(sampleRate),
    "-i", q(rawGpu), "-c:a", "aac", "-b:a", q(audioBitrate), q(normalizedAudio),
  ].join(" ");
  const muxArgs = [
    q(args.ffmpegPath), "-hide_banner", "-nostats", "-nostdin", "-y", "-i", q(args.inputFileObj._id), "-i", q(normalizedAudio),
    "-map", "0:v?", "-map", "1:a:0",
  ];
  for (let idx = 1; idx < audioStreams.length; idx += 1) muxArgs.push("-map", `0:a:${idx}?`);
  muxArgs.push("-map", "0:s?", "-map", "0:t?", "-map", "0:d?", "-map_chapters", "0", "-map_metadata", "0", "-c", "copy", "-metadata:s:a:0", q(`language=${language}`), q(outputFilePath));
  const mux = muxArgs.join(" ");
  const sourceExactScript = [
    source,
    `cat ${q(sourceErr)} >&2`,
    `if ! ${maxGainGate}; then echo 'OPX exact normalize gain gate exceeded; copying original package'; ${copyOriginal}; rm -f ${q(rawInput)} ${q(gains)} ${q(sourceErr)} ${q(rawGpu)} ${q(normalizedAudio)}; exit 0; fi`,
    apply,
  ];
  const gpuPlanScript = [
    "set +e",
    gpuPlan,
    "opx_rc=$?",
    "set -e",
    `cat ${q(sourceErr)} >&2`,
    `if [ "$opx_rc" -eq 42 ]; then echo 'OPX exact normalize gain gate exceeded; copying original package'; ${copyOriginal}; rm -f ${q(rawInput)} ${q(gains)} ${q(sourceErr)} ${q(rawGpu)} ${q(normalizedAudio)}; exit 0; fi`,
    `test "$opx_rc" -eq 0`,
  ];
  const script = [
    "set -euo pipefail",
    `rm -f ${q(rawInput)} ${q(gains)} ${q(sourceErr)} ${q(rawGpu)} ${q(normalizedAudio)} ${q(outputFilePath)}`,
    decode,
    `bytes=$(wc -c < ${q(rawInput)}); test "$bytes" -le ${maxBytes}`,
    ...(useGpuSourcePort ? gpuPlanScript : sourceExactScript),
    encode,
    mux,
    `test -s ${q(outputFilePath)}`,
    `rm -f ${q(rawInput)} ${q(gains)} ${q(sourceErr)} ${q(rawGpu)} ${q(normalizedAudio)}`,
  ].join("; ");

  args.jobLog(useGpuSourcePort
    ? "Running OPX GPU source-port canary normalize: FFmpeg decode -> CUDA FFmpeg-source-port loudness/gain plan+apply -> FFmpeg encode/mux"
    : "Running OPX GPU exact dev normalize: FFmpeg decode -> source-core exact gains -> CUDA apply -> FFmpeg encode/mux");
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
  if (res.cliExitCode !== 0) throw new Error("OPX GPU exact dev normalize failed");
  return { outputFileObj: { _id: outputFilePath }, outputNumber: 1, variables: args.variables };
};
exports.plugin = plugin;
