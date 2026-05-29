"use strict";

const {
  boolInput,
} = require("./common");
const {
  initializePluginInputs,
} = require("./pluginBootstrap");

function initializePluginRun({ args, details }) {
  const { getContainer, getFileName, getPluginWorkDir } = initializePluginInputs(args, details);
  const debugLogging = boolInput(args.inputs.debugLogging, false) || args.logFullCliOutput === true;
  args.logFullCliOutput = debugLogging;

  const streams = (((args.inputFileObj || {}).ffProbeData || {}).streams || []);
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
  const requireGpuWorker = boolInput(args.inputs.requireGpuWorker, true);
  const workerType = String(args.workerType || "").trim().toLowerCase();
  if (requireGpuWorker && workerType && workerType !== "transcodegpu") {
    throw new Error(`GPU Normalize Audio must run on a Transcode GPU worker; Tdarr scheduled workerType=${workerType}. Add a Worker Type gate or disable Transcode CPU workers for this flow.`);
  }
  const earlyResult = audioStreams.length === 0 ? (() => {
    args.jobLog("No audio streams found; skipping GPU normalize.");
    return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
  })() : null;

  return {
    audioStreams,
    debugLogging,
    earlyResult,
    getContainer,
    getFileName,
    getPluginWorkDir,
    requireGpuWorker,
    workerType,
  };
}

module.exports = {
  initializePluginRun,
};
