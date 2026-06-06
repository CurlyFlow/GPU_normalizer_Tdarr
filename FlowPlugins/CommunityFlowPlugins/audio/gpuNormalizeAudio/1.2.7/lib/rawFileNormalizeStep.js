"use strict";

const {
  gpuProgressFraction,
  logProfileStage,
} = require("./common");

async function runRawNormalizeStep({
  args,
  debugLogging,
  plan,
  planLabel,
  completedWork,
  measureSpan,
  decodeSpan,
  normalizeSpan,
  cpuLoudnormValues,
  useGpuSourcePort,
  targetI,
  maxGain,
  buildRawApplyCommand,
  buildRawSourcePortGpuPlan,
  buildSourceCoreGainsCommand,
  wrapRuntimeProfile,
  runShell,
  runChecked,
  copyOriginalPackage,
  updateProgress,
}) {
  if (useGpuSourcePort) {
    const gpuPlan = buildRawSourcePortGpuPlan(plan, cpuLoudnormValues, plan.rawInput, plan.rawGpu);
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
      return { outputResult: await copyOriginalPackage(`GPU normalize gain gate exceeded on ${planLabel}; copying original package`, completedWork + measureSpan + decodeSpan + normalizeSpan) };
    }
    if (gpuRes.code !== 0) throw new Error(`GPU normalize failed on ${planLabel}`);
    return { outputResult: null };
  }

  const source = buildSourceCoreGainsCommand(plan);
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
      return { outputResult: await copyOriginalPackage(`GPU normalize gain gate exceeded on ${planLabel}; copying original package`, completedWork + decodeSpan + normalizeSpan) };
    }
  }
  const apply = buildRawApplyCommand(plan);
  updateProgress(completedWork + decodeSpan + normalizeSpan * 0.65, true);
  const applyRes = await runChecked(apply, { label: `GPU apply ${planLabel}`, logOnSuccess: debugLogging });
  logProfileStage(args, { scope: "plugin", name: "gpu_apply", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: applyRes.wallSec });
  return { outputResult: null };
}

module.exports = {
  runRawNormalizeStep,
};
