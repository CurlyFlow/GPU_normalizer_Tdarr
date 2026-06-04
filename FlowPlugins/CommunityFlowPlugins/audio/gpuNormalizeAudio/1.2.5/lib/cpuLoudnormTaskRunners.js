"use strict";

const {
  createGpuFirstPassTaskRunner,
} = require("./cpuLoudnormGpuFirstPassTask");
const {
  createCpuLoudnormMeasureTaskRunners,
} = require("./cpuLoudnormMeasureTasks");

function createCpuLoudnormTaskRunners({
  args,
  debugLogging,
  backgroundCpuGroup,
  buildCpuLoudnormMeasure,
  buildGpuFirstPassMeasure,
  buildPairedCpuLoudnormMeasure,
  cpuLoudnormKey,
  cpuLoudnormMeasurementStore,
  gpuFirstPassAudit,
  loudnessSummary,
  planLabelFor,
  processingSampleRateFor,
  runChecked,
  statsCachePathFor,
  trackStatsCachePath,
  wrapRuntimeProfile,
}) {
  const {
    compareGpuFirstPassValues,
    runGpuFirstPassMeasure,
    startGpuFirstPassTask: startGpuFirstPassTaskInner,
  } = createGpuFirstPassTaskRunner({
    args,
    debugLogging,
    backgroundCpuGroup,
    buildGpuFirstPassMeasure,
    cpuLoudnormMeasurementStore,
    loudnessSummary,
    planLabelFor,
    processingSampleRateFor,
    runChecked,
    statsCachePathFor,
    trackStatsCachePath,
    wrapRuntimeProfile,
  });
  const startGpuFirstPassTask = (plan, options) => {
    const task = startGpuFirstPassTaskInner(plan, options);
    cpuLoudnormMeasurementStore.publishTask(options.key, task);
    return task;
  };
  const {
    startPairedCpuLoudnormTask,
    startSingleCpuLoudnormTask,
  } = createCpuLoudnormMeasureTaskRunners({
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
  });

  return {
    startGpuFirstPassTask,
    startPairedCpuLoudnormTask,
    startSingleCpuLoudnormTask,
  };
}

module.exports = {
  createCpuLoudnormTaskRunners,
};
