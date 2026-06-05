"use strict";

const {
  parseLoudnormJson,
  parseLoudnormJsonBlocks,
} = require("./common");
const {
  validateLoudnormValues,
} = require("./cpuLoudnormTaskUtils");

function createCpuLoudnormMeasureTaskRunners({
  args,
  debugLogging,
  backgroundCpuGroup,
  buildCpuLoudnormMeasure,
  buildPairedCpuLoudnormMeasure,
  compareGpuFirstPassValues,
  cpuLoudnormKey,
  cpuLoudnormMeasurementStore,
  gpuFirstPassAudit,
  loudnessSummary,
  planLabelFor,
  runGpuFirstPassMeasure,
  runChecked,
}) {
  const startPairedCpuLoudnormTask = (plan, partner, { key, partnerKey, background, queuedAt, opts }) => {
    const originalPlan = plan.stereoFallback ? partner : plan;
    const stereoPlan = plan.stereoFallback ? plan : partner;
    const originalKey = cpuLoudnormKey(originalPlan);
    const stereoKey = cpuLoudnormKey(stereoPlan);
    const pairTask = (async () => {
      const startedAt = Date.now();
      const measureRes = await runChecked(buildPairedCpuLoudnormMeasure(plan, partner, { background }), {
        label: `${background ? "prefetch " : ""}paired CPU loudnorm first pass ${planLabelFor(originalPlan)} + ${planLabelFor(stereoPlan)}`,
        capturePath: plan.measureErr,
        logOnSuccess: debugLogging && !background,
        processGroup: background ? backgroundCpuGroup : null,
        parseLine: background ? undefined : opts.parseLine,
      });
      const blocks = parseLoudnormJsonBlocks(measureRes.output);
      if (blocks.length < 2) throw new Error("GPU normalize: paired CPU loudnorm did not produce two JSON blocks");
      const stereoValues = blocks[0];
      const originalValues = blocks[1];
      validateLoudnormValues(originalValues);
      validateLoudnormValues(stereoValues);
      const baseResult = {
        wallSec: measureRes.wallSec,
        source: background ? "paired_prefetched" : "paired_measured",
        background,
        queuedSec: (startedAt - queuedAt) / 1000,
      };
      const originalResult = { ...baseResult, values: originalValues };
      const stereoResult = { ...baseResult, values: stereoValues };
      cpuLoudnormMeasurementStore.publishRecord(originalKey, originalResult);
      cpuLoudnormMeasurementStore.publishRecord(stereoKey, stereoResult);
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
    cpuLoudnormMeasurementStore.publishTask(key, currentTask);
    cpuLoudnormMeasurementStore.publishTask(partnerKey, partnerTask);
    return currentTask;
  };

  const startSingleCpuLoudnormTask = (plan, { key, background, queuedAt, opts }) => {
    const planLabel = planLabelFor(plan);
    const task = (async () => {
      const startedAt = Date.now();
      const measureRes = await runChecked(buildCpuLoudnormMeasure(plan, { background }), {
        label: `${background ? "prefetch " : ""}CPU loudnorm first pass ${planLabel}`,
        capturePath: plan.measureErr,
        logOnSuccess: debugLogging && !background,
        processGroup: background ? backgroundCpuGroup : null,
        parseLine: background ? undefined : opts.parseLine,
      });
      const values = parseLoudnormJson(measureRes.output);
      validateLoudnormValues(values);
      if (gpuFirstPassAudit) {
        const gpuAudit = await runGpuFirstPassMeasure(plan, { background, writeStatsCache: false });
        compareGpuFirstPassValues(planLabel, values, gpuAudit.values);
      }
      const result = {
        values,
        wallSec: measureRes.wallSec,
        source: background ? "prefetched" : "measured",
        background,
        queuedSec: (startedAt - queuedAt) / 1000,
      };
      cpuLoudnormMeasurementStore.publishRecord(key, result);
      if (!background) args.jobLog(`GPU Normalize Audio result: measured ${planLabel}: ${loudnessSummary(values)}.`);
      else if (debugLogging) args.jobLog(`GPU normalize CPU loudnorm first pass ${planLabel} prefetched: ${JSON.stringify(values)}`);
      return result;
    })();
    if (background) {
      task.catch((err) => {
        if (!backgroundCpuGroup.cancelled) args.jobLog(`GPU normalize CPU loudnorm prefetch failed for ${planLabel}: ${err.message}`);
      });
    }
    cpuLoudnormMeasurementStore.publishTask(key, task);
    return task;
  };

  return {
    startPairedCpuLoudnormTask,
    startSingleCpuLoudnormTask,
  };
}

module.exports = {
  createCpuLoudnormMeasureTaskRunners,
};
