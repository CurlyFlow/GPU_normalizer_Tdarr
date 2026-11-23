"use strict";

const {
  niceCommand,
  parseLoudnormJson,
} = require("./common");
const {
  validateLoudnormValues,
} = require("./cpuLoudnormTaskUtils");
const {
  FIRST_PASS_BACKEND,
} = require("./cpuLoudnormFirstPassPlan");
const {
  cancelShellProcessGroup,
  sleep,
} = require("./shell");

function combineMixedLoudnormValues(inputValues, outputValues) {
  return {
    ...outputValues,
    input_i: inputValues.input_i,
    input_tp: inputValues.input_tp,
    input_lra: inputValues.input_lra,
    input_thresh: inputValues.input_thresh,
  };
}

function finalizeFirstPassValues(plan, values, parityPolicy, markers) {
  parityPolicy.apply(plan, values);
  validateLoudnormValues(values);
  return Object.assign(values, markers);
}

function createGpuFirstPassExecutionBackends({
  args,
  debugLogging,
  backgroundCpuGroup,
  buildGpuFirstPassInputMeasure,
  buildGpuFirstPassMeasure,
  parityPolicy,
  runChecked,
  wrapRuntimeProfile,
}) {
  const runFirstPassCommand = (command, plan, profileName, task, options) => runChecked(options.preWrapped ? command : wrapRuntimeProfile(command, plan, profileName), {
    label: `${task.background ? "prefetch " : ""}${options.label}`,
    capturePath: options.capturePath,
    logOnSuccess: debugLogging && !task.background,
    processGroup: backgroundCpuGroup,
    parseLine: task.background ? undefined : task.opts.parseLine,
  });

  const resultBase = (firstPassPlan, task, wallSec, source) => ({
    wallSec,
    source: firstPassPlan.writeStatsCache ? source : `${source}_audit`,
    background: task.background,
    queuedSec: (task.startedAt - (task.opts.queuedAt || task.startedAt)) / 1000,
    statsSampleRate: firstPassPlan.statsSampleRate,
    statsCache: firstPassPlan.statsCache,
  });

  const runSingleMeasureBackend = (source, markers) => async ({ plan, firstPassPlan, task }) => {
    const measureRes = await runFirstPassCommand(
      buildGpuFirstPassMeasure(plan, firstPassPlan.statsSampleRate, firstPassPlan.statsCache, firstPassPlan.writeCompatibleStatsCache),
      plan,
      "first-pass",
      task,
      {
        label: `GPU loudnorm first pass ${task.planLabel}`,
        capturePath: plan.measureErr,
      },
    );
    const values = finalizeFirstPassValues(plan, parseLoudnormJson(measureRes.output), parityPolicy, markers);
    return {
      values,
      ...resultBase(firstPassPlan, task, measureRes.wallSec, source),
    };
  };

  const runPlainBackend = runSingleMeasureBackend("gpu_first_pass", { _gpuFirstPass: true });
  const runFusedBackend = runSingleMeasureBackend("gpu_first_pass_fused", { _gpuFirstPass: true, _gpuFirstPassFused: true });

  const runMixedBackend = async ({ plan, firstPassPlan, task }) => {
    const inputMeasure = async () => {
      if (firstPassPlan.mixedInputDelayMs > 0) {
        args.jobLog(`GPU normalize delaying mixed first-pass input measure by ${firstPassPlan.mixedInputDelayMs}ms`);
        await sleep(firstPassPlan.mixedInputDelayMs);
      }
      if (firstPassPlan.mixedInputNice > 0) {
        args.jobLog(`GPU normalize lowering mixed first-pass input measure priority with nice ${firstPassPlan.mixedInputNice}`);
      }
      const inputCommand = wrapRuntimeProfile(
        buildGpuFirstPassInputMeasure(plan, firstPassPlan.processingSampleRate, firstPassPlan.statsCache, firstPassPlan.writeCompatibleStatsCache),
        plan,
        "first-pass-input",
      );
      return await runFirstPassCommand(
        niceCommand(inputCommand, firstPassPlan.mixedInputNice),
        plan,
        "first-pass-input",
        task,
        {
          label: `GPU loudnorm first pass input ${task.planLabel}`,
          capturePath: firstPassPlan.mixedParallel ? `${plan.measureErr}.input` : plan.measureErr,
          preWrapped: true,
        },
      );
    };
    const outputMeasure = () => runFirstPassCommand(
      buildGpuFirstPassMeasure(plan, plan.sourceSampleRate, "", false),
      plan,
      "first-pass-output",
      task,
      {
        label: `GPU loudnorm first pass output ${task.planLabel}`,
        capturePath: firstPassPlan.mixedParallel ? `${plan.measureErr}.output` : plan.measureErr,
      },
    );

    let inputRes;
    let outputRes;
    if (firstPassPlan.mixedParallel) {
      const tasks = [inputMeasure(), outputMeasure()];
      try {
        [inputRes, outputRes] = await Promise.all(tasks);
      } catch (error) {
        cancelShellProcessGroup(backgroundCpuGroup);
        await Promise.allSettled(tasks);
        throw error;
      }
    } else {
      inputRes = await inputMeasure();
      outputRes = await outputMeasure();
    }
    const values = finalizeFirstPassValues(
      plan,
      combineMixedLoudnormValues(parseLoudnormJson(inputRes.output), parseLoudnormJson(outputRes.output)),
      parityPolicy,
      { _gpuFirstPass: true, _gpuFirstPassMixed: true },
    );
    return {
      values,
      ...resultBase(firstPassPlan, task, firstPassPlan.mixedParallel ? (Date.now() - task.startedAt) / 1000 : inputRes.wallSec + outputRes.wallSec, "gpu_first_pass_mixed"),
    };
  };

  return async ({ plan, firstPassPlan, task }) => {
    switch (firstPassPlan.backend) {
      case FIRST_PASS_BACKEND.PLAIN:
        return await runPlainBackend({ plan, firstPassPlan, task });
      case FIRST_PASS_BACKEND.MIXED:
        return await runMixedBackend({ plan, firstPassPlan, task });
      case FIRST_PASS_BACKEND.FUSED:
        return await runFusedBackend({ plan, firstPassPlan, task });
      default:
        throw new Error(`unknown GPU first-pass backend: ${firstPassPlan.backend}`);
    }
  };
}

module.exports = {
  createGpuFirstPassExecutionBackends,
};
