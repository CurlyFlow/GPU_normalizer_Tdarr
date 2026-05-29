"use strict";

const {
  createCpuLoudnormScheduler,
} = require("./cpuLoudnormScheduler");
const {
  createCpuLoudnormTaskRunners,
} = require("./cpuLoudnormTaskRunners");

function createCpuLoudnormCoordinator({
  args,
  debugLogging,
  useGpuSourcePort,
  gpuFirstPassMeasure,
  gpuFirstPassAudit,
  runChecked,
  wrapRuntimeProfile,
  buildGpuFirstPassMeasure,
  buildCpuLoudnormMeasure,
  buildPairedCpuLoudnormMeasure,
  processingSampleRateFor,
  statsCachePathFor,
  sourceChannelsFor,
  pairedCpuLoudnormPartner,
  planLabelFor,
  loudnessSummary,
  cachedCpuLoudnormForPlan,
  canFuseAnyCpuLoudnormWithSplitStats,
  processingPlans,
}) {
  const cpuLoudnormResults = new Map();
  const cpuLoudnormTasks = new Map();
  const backgroundCpuGroup = { procs: new Set(), cancelled: false };

  const cpuLoudnormKey = (plan) => `${plan.sourceIdx}:${plan.channels}`;
  const {
    startGpuFirstPassTask,
    startPairedCpuLoudnormTask,
    startSingleCpuLoudnormTask,
  } = createCpuLoudnormTaskRunners({
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
  });
  const {
    cancelBackgroundCpu,
    getCpuLoudnormRecord,
    knownCpuLoudnormValues,
    prefetchCpuLoudnormFrom,
    prefetchNextCpuLoudnorm,
    settleCpuLoudnormTasks,
    startCpuLoudnormTask,
  } = createCpuLoudnormScheduler({
    args,
    backgroundCpuGroup,
    cachedCpuLoudnormForPlan,
    canFuseAnyCpuLoudnormWithSplitStats,
    cpuLoudnormKey,
    cpuLoudnormResults,
    cpuLoudnormTasks,
    gpuFirstPassMeasure,
    pairedCpuLoudnormPartner,
    planLabelFor,
    processingPlans,
    startGpuFirstPassTask,
    startPairedCpuLoudnormTask,
    startSingleCpuLoudnormTask,
    useGpuSourcePort,
  });

  return {
    backgroundCpuGroup,
    cancelBackgroundCpu,
    cpuLoudnormKey,
    cpuLoudnormResults,
    cpuLoudnormTasks,
    getCpuLoudnormRecord,
    knownCpuLoudnormValues,
    prefetchCpuLoudnormFrom,
    prefetchNextCpuLoudnorm,
    settleCpuLoudnormTasks,
    startCpuLoudnormTask,
  };
}

module.exports = {
  createCpuLoudnormCoordinator,
};
