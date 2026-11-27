"use strict";

const {
  boolInput,
} = require("./common");
const {
  initializePluginInputs,
} = require("./pluginBootstrap");
const {
  createPluginRuntimeConfig,
} = require("./pluginConfig");
const {
  createPluginPlanSetup,
} = require("./pluginPlanSetup");
const { rejectInput } = require("./inputRejection");

function initializePluginRun({ args, details }) {
  const { getContainer, getFileName, getPluginWorkDir } = initializePluginInputs(args, details);
  const debugLogging = boolInput(args.inputs.debugLogging, false) || args.logFullCliOutput === true;
  args.logFullCliOutput = debugLogging;

  const streams = (((args.inputFileObj || {}).ffProbeData || {}).streams);
  if (!Array.isArray(streams)) throw new Error("GPU Normalize Audio requires probed stream data; refusing to classify an unprobed file as having no audio.");
  args.variables = { ...args.variables, mediaPipelineAudioExpectation: {
    schema: "media-audio-expectation.v1", inputId: args.inputFileObj._id, startedAt: new Date().toISOString(),
    requestedInputs: Object.fromEntries(details().inputs.map(input => [input.name, args.inputs[input.name]])),
  } };
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
  const earlyResult = audioStreams.length === 0
    ? rejectInput(args, "noAudioStreams") : null;
  const requireGpuWorker = boolInput(args.inputs.requireGpuWorker, true);
  const workerType = String(args.workerType || "").trim().toLowerCase();
  if (!earlyResult && requireGpuWorker && workerType && workerType !== "transcodegpu") {
    throw new Error(`GPU Normalize Audio must run on a Transcode GPU worker; Tdarr scheduled workerType=${workerType}. Add a Worker Type gate or disable Transcode CPU workers for this flow.`);
  }

  return {
    audioStreams,
    debugLogging,
    earlyResult,
    getContainer,
    getFileName,
    getPluginWorkDir,
    requireGpuWorker,
    streams,
    workerType,
  };
}

function createPlanSetupInput({ args, preflight, runtimeConfig }) {
  const { audioConfig, outputPathConfig } = runtimeConfig;
  return {
    args,
    audioStreams: preflight.audioStreams,
    inputStreams: preflight.streams,
    debugLogging: preflight.debugLogging,
    audioBitrate: audioConfig.audioBitrate,
    base: outputPathConfig.base,
    container: outputPathConfig.audioCompatibilityContainer,
    durationSeconds: outputPathConfig.durationSeconds,
    ensureStereo: audioConfig.ensureStereo,
    fallbackToUndetectedAudio: audioConfig.fallbackToUndetectedAudio,
    gpuInputExt: audioConfig.gpuInputExt,
    gpuInputFormat: audioConfig.gpuInputFormat,
    gpuOutputExt: audioConfig.gpuOutputExt,
    gpuOutputFormat: audioConfig.gpuOutputFormat,
    normalizeOnlyLanguages: audioConfig.normalizeOnlyLanguages,
    removeOtherLanguages: audioConfig.removeOtherLanguages,
    runId: outputPathConfig.runId,
    sampleRate: audioConfig.sampleRate,
    stereoFallbackFirstOnly: audioConfig.stereoFallbackFirstOnly,
    stereoLanguageOrder: audioConfig.stereoLanguageOrder,
    tmpOutputFilePath: outputPathConfig.tmpOutputFilePath,
    workDir: outputPathConfig.workDir,
  };
}

function createPluginMainSetup({
  args,
  details,
  runtimeBin,
}) {
  const preflight = initializePluginRun({ args, details });
  if (preflight.earlyResult) return { earlyResult: preflight.earlyResult };

  const runtimeConfig = createPluginRuntimeConfig({
    args,
    runtimeBin,
    getContainer: preflight.getContainer,
    getFileName: preflight.getFileName,
    getPluginWorkDir: preflight.getPluginWorkDir,
  });
  const planSetup = createPluginPlanSetup(createPlanSetupInput({ args, preflight, runtimeConfig }));
  if (planSetup.earlyResult) return { earlyResult: planSetup.earlyResult };

  return {
    planSetup,
    preflight,
    runtimeConfig,
  };
}

module.exports = {
  createPluginMainSetup,
};
