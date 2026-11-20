"use strict";

const {
  boolInput,
  envFlag,
  intNum,
  normalizeNsysSample,
  num,
  parseDurationSeconds,
} = require("./common");
const {
  normalizeOnlyLanguageOrder,
  stereoFallbackLanguageOrder,
} = require("./audioLanguageOrder");
const fs = require("fs");

function createPluginAudioConfig({
  args,
  useGpuSourcePort,
}) {
  const defaultChunkMiB = String(process.env.LOUDNORM_GPU_CHUNK_MIB || "1").trim() || "1";
  const stereoFallbackChunkMiB = String(process.env.LOUDNORM_GPU_STEREO_FALLBACK_CHUNK_MIB || "").trim();
  const stereoFallbackApplyChunkMiB = String(process.env.LOUDNORM_GPU_STEREO_FALLBACK_APPLY_CHUNK_MIB || "").trim();
  const originalApplyChunkMiB = String(process.env.LOUDNORM_GPU_ORIGINAL_APPLY_CHUNK_MIB || "2").trim();

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
  const removeOtherLanguages = boolInput(args.inputs.removeOtherLanguages, true);
  const fallbackToUndetectedAudio = boolInput(args.inputs.fallbackToUndetectedAudio, true);
  const audioBitrate = String(args.inputs.audioBitrate || "192k").replace(/[^0-9kKmM]/g, "") || "192k";
  const encodeThreadsInput = String(process.env.LOUDNORM_GPU_ENCODE_THREADS || "2").trim();
  const originalEncodeThreadsInput = process.env.LOUDNORM_GPU_ORIGINAL_ENCODE_THREADS;
  const stereoFallbackEncodeThreadsInput = process.env.LOUDNORM_GPU_STEREO_FALLBACK_ENCODE_THREADS ?? "1";
  const encodeThreadArgs = (plan = null) => {
    const specificInput = plan
      ? (plan.stereoFallback ? stereoFallbackEncodeThreadsInput : originalEncodeThreadsInput)
      : undefined;
    const threadInput = String(specificInput !== undefined ? specificInput : encodeThreadsInput).trim();
    if (!threadInput) return [];
    return ["-threads", String(Math.max(0, Math.min(64, intNum(threadInput, 0))))];
  };
  const gpuInputFormat = useGpuSourcePort ? "f64le" : "f32le";
  const gpuInputExt = useGpuSourcePort ? "f64" : "f32";
  const gpuOutputFormat = useGpuSourcePort ? "f64le" : "f32le";
  const gpuOutputExt = useGpuSourcePort ? "f64" : "f32";
  const useStreamingSourcePort = useGpuSourcePort;

  return {
    audioBitrate,
    defaultChunkMiB,
    encodeThreadArgs,
    ensureStereo,
    fallbackToUndetectedAudio,
    forcedEncodeSampleRate,
    gpuInputExt,
    gpuInputFormat,
    gpuOutputExt,
    gpuOutputFormat,
    maxGain,
    normalizeOnlyLanguages,
    originalApplyChunkMiB,
    removeOtherLanguages,
    sampleRate,
    stereoFallbackApplyChunkMiB,
    stereoFallbackChunkMiB,
    stereoFallbackFirstOnly,
    stereoLanguageOrder,
    targetI,
    targetLra,
    targetTp,
    useStreamingSourcePort,
  };
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

function createRuntimePathConfig({ args, runtimeBin }) {
  const plannerMode = String(args.inputs.plannerMode || "gpuSourcePort").trim();
  const useGpuSourcePort = plannerMode === "gpuSourcePort";
  const sourceCorePath = String(args.inputs.sourceCorePath || `${runtimeBin}/loudnorm-source-cpu`).trim();
  const gpuPlanCorePath = String(args.inputs.gpuPlanCorePath || `${runtimeBin}/loudnorm-gpu-source-port`).trim();
  const gpuApplyPath = String(args.inputs.gpuApplyPath || `${runtimeBin}/gpu-apply-sample-gains`).trim();
  const pythonPath = String(process.env.PYTHON || "python3").trim() || "python3";
  const gpuPlanCoreCommand = () => {
    ensureReadableRuntime("GPU plan core", gpuPlanCorePath);
    return [pythonPath, "-X", "faulthandler", gpuPlanCorePath];
  };

  if (useGpuSourcePort) {
    ensureReadableRuntime("GPU plan core", gpuPlanCorePath);
  } else {
    ensureExecutableRuntime("Source core", sourceCorePath);
    ensureExecutableRuntime("GPU apply", gpuApplyPath);
  }

  return {
    gpuApplyPath,
    gpuPlanCoreCommand,
    pythonPath,
    sourceCorePath,
    useGpuSourcePort,
  };
}

function createOutputPathConfig({
  args,
  getContainer,
  getFileName,
  getPluginWorkDir,
}) {
  const durationSeconds = parseDurationSeconds(args.inputFileObj) || 1;
  const container = getContainer(args.inputFileObj._id);
  const workDir = getPluginWorkDir(args);
  const base = getFileName(args.inputFileObj._id);
  const runId = `${process.pid}-${Date.now()}`;
  const outputFilePath = `${workDir}/${base}.${container}`;
  const tmpOutputFilePath = `${workDir}/${base}.tmp-${runId}.${container}`;
  if (outputFilePath === args.inputFileObj._id) throw new Error(`GPU normalize output path equals input path: ${outputFilePath}`);

  return {
    base,
    container,
    // Codec compatibility can target a later remux without changing this package's container.
    audioCompatibilityContainer: boolInput(args.inputs.mp4CompatibleAudio, false) ? "mp4" : container,
    durationSeconds,
    outputFilePath,
    runId,
    tmpOutputFilePath,
    workDir,
  };
}

function createRuntimeFeatureConfig({
  args,
  durationSeconds,
  useGpuSourcePort,
  useStreamingSourcePort,
}) {
  const pairCpuLoudnormMeasure = envFlag("LOUDNORM_GPU_PAIR_CPU_LOUDNORM_MEASURE", false);
  const gpuFirstPassMinSeconds = Math.max(0, Math.min(86400, intNum(process.env.LOUDNORM_GPU_FIRST_PASS_MIN_SECONDS, 120)));
  const gpuFirstPassDefault = Number(durationSeconds) >= gpuFirstPassMinSeconds;
  const gpuFirstPassMeasure = useGpuSourcePort && useStreamingSourcePort && args.platform !== "win32" && envFlag("LOUDNORM_GPU_FIRST_PASS_MEASURE", gpuFirstPassDefault);
  const gpuFirstPassOriginalOnly = gpuFirstPassMeasure && envFlag("LOUDNORM_GPU_FIRST_PASS_ORIGINAL_ONLY", true);
  const gpuFirstPassAudit = useGpuSourcePort && useStreamingSourcePort && args.platform !== "win32" && !gpuFirstPassMeasure && envFlag("LOUDNORM_GPU_FIRST_PASS_AUDIT");
  const cpuLoudnormNice = args.platform !== "win32" ? Math.max(0, Math.min(19, intNum(process.env.LOUDNORM_GPU_CPU_LOUDNORM_NICE, 0))) : 0;

  return {
    cpuLoudnormNice,
    gpuFirstPassAudit,
    gpuFirstPassMeasure,
    gpuFirstPassOriginalOnly,
    gpuFirstPassMinSeconds,
    pairCpuLoudnormMeasure,
  };
}

function createDiagnosticsConfig({ workDir }) {
  const nsysRuntimeProfile = envFlag("LOUDNORM_GPU_NSYS");
  const nsysBin = String(process.env.LOUDNORM_GPU_NSYS_BIN || "nsys").trim() || "nsys";
  const nsysTrace = String(process.env.LOUDNORM_GPU_NSYS_TRACE || "cuda,osrt,nvtx").trim() || "cuda,osrt,nvtx";
  const nsysSample = normalizeNsysSample(process.env.LOUDNORM_GPU_NSYS_SAMPLE || "none");
  const nsysOutputDir = String(process.env.LOUDNORM_GPU_NSYS_OUTPUT_DIR || workDir).trim() || workDir;

  return {
    nsysBin,
    nsysOutputDir,
    nsysRuntimeProfile,
    nsysSample,
    nsysTrace,
  };
}

function createPluginRuntimeConfig({
  args,
  runtimeBin,
  getContainer,
  getFileName,
  getPluginWorkDir,
}) {
  const runtimePathConfig = createRuntimePathConfig({ args, runtimeBin });
  const {
    useGpuSourcePort,
  } = runtimePathConfig;
  const audioConfig = createPluginAudioConfig({
    args,
    useGpuSourcePort,
  });
  const outputPathConfig = createOutputPathConfig({
    args,
    getContainer,
    getFileName,
    getPluginWorkDir,
  });
  const featureConfig = createRuntimeFeatureConfig({
    args,
    durationSeconds: outputPathConfig.durationSeconds,
    useGpuSourcePort,
    useStreamingSourcePort: audioConfig.useStreamingSourcePort,
  });
  const diagnosticsConfig = createDiagnosticsConfig({
    workDir: outputPathConfig.workDir,
  });

  return {
    audioConfig,
    diagnosticsConfig,
    featureConfig,
    outputPathConfig,
    runtimePathConfig,
  };
}

module.exports = {
  createPluginAudioConfig,
  createPluginRuntimeConfig,
};
