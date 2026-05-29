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
  cpuLoudnormResults,
  cpuLoudnormTasks,
  gpuFirstPassAudit,
  loudnessSummary,
  planLabelFor,
  processingSampleRateFor,
  runChecked,
  statsCachePathFor,
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
    cpuLoudnormResults,
    loudnessSummary,
    planLabelFor,
    processingSampleRateFor,
    runChecked,
    statsCachePathFor,
    wrapRuntimeProfile,
  });
  const startGpuFirstPassTask = (plan, options) => {
    const task = startGpuFirstPassTaskInner(plan, options);
    cpuLoudnormTasks.set(options.key, task);
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
    cpuLoudnormResults,
    cpuLoudnormTasks,
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
