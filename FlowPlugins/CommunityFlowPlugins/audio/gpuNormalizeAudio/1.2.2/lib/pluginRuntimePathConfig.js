"use strict";

const {
  q,
} = require("./common");
const {
  ensureExecutableRuntime,
  ensureReadableRuntime,
} = require("./runtimePaths");

function createPluginRuntimePathConfig({ args, runtimeBin }) {
  const plannerMode = String(args.inputs.plannerMode || "gpuSourcePort").trim();
  const useGpuSourcePort = plannerMode === "gpuSourcePort";
  const sourceCorePath = String(args.inputs.sourceCorePath || `${runtimeBin}/loudnorm-source-cpu`).trim();
  const gpuPlanCorePath = String(args.inputs.gpuPlanCorePath || `${runtimeBin}/loudnorm-gpu-source-port`).trim();
  const gpuApplyPath = String(args.inputs.gpuApplyPath || `${runtimeBin}/gpu-apply-sample-gains`).trim();
  const pythonPath = String(process.env.PYTHON || "python3").trim() || "python3";
  const gpuPlanCoreCommand = () => {
    ensureReadableRuntime("GPU plan core", gpuPlanCorePath);
    return [q(pythonPath), q(gpuPlanCorePath)];
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

module.exports = {
  createPluginRuntimePathConfig,
};
