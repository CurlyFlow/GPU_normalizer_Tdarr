"use strict";

const {
  createCpuLoudnormScheduler,
} = require("./cpuLoudnormScheduler");
const {
  createCpuLoudnormTaskRunners,
} = require("./cpuLoudnormTaskRunners");
const {
  createLoudnormMeasurementStore,
} = require("./loudnormMeasurementStore");

function createCpuLoudnormCoordinator({
  args,
  debugLogging,
  useGpuSourcePort,
  gpuFirstPassMeasure,
  gpuFirstPassAudit,
  runChecked,
  wrapRuntimeProfile,
  buildGpuFirstPassInputMeasure,
  buildGpuFirstPassMeasure,
  buildCpuLoudnormMeasure,
  buildPairedCpuLoudnormMeasure,
  processingSampleRateFor,
  statsCachePathFor,
  trackStatsCachePath,
  sourceChannelsFor,
  pairedCpuLoudnormPartner,
  planLabelFor,
  loudnessSummary,
  cachedCpuLoudnormForPlan,
  cpuMeasurementAvailability,
  processingPlans,
}) {
  const backgroundCpuGroup = { procs: new Set(), cancelled: false };

  const cpuLoudnormKey = (plan) => `${plan.sourceIdx}:${plan.channels}`;
  const cpuLoudnormMeasurementStore = createLoudnormMeasurementStore({ keyForPlan: cpuLoudnormKey });
  const {
    startGpuFirstPassTask,
    startPairedCpuLoudnormTask,
    startSingleCpuLoudnormTask,
  } = createCpuLoudnormTaskRunners({
    args,
    debugLogging,
    backgroundCpuGroup,
    buildCpuLoudnormMeasure,
    buildGpuFirstPassInputMeasure,
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
    cpuMeasurementAvailability,
    cpuLoudnormKey,
    cpuLoudnormMeasurementStore,
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
    cpuLoudnormMeasurementStore,
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
