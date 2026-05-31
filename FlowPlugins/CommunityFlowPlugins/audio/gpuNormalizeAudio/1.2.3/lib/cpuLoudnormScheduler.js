"use strict";

const {
  terminateShellProcess,
} = require("./shell");

function createCpuLoudnormScheduler({
  args,
  backgroundCpuGroup,
  cachedCpuLoudnormForPlan,
  cpuMeasurementAvailability = {},
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
}) {
  const shouldWaitForFusedProducer = cpuMeasurementAvailability.shouldWaitForFusedProducer || (() => false);
  const startCpuLoudnormTask = (plan, opts = {}) => {
    const key = cpuLoudnormKey(plan);
    const existingResult = cpuLoudnormMeasurementStore.getRecord(key);
    if (existingResult) return Promise.resolve(existingResult);
    const existingTask = cpuLoudnormMeasurementStore.getTask(key);
    if (existingTask) return existingTask;
    const background = opts.background === true;
    const queuedAt = Date.now();
    if (gpuFirstPassMeasure) {
      return startGpuFirstPassTask(plan, { key, background, queuedAt, opts });
    }
    const partner = pairedCpuLoudnormPartner(plan);
    if (partner) {
      const partnerKey = cpuLoudnormKey(partner);
      const partnerExistingResult = cpuLoudnormMeasurementStore.getRecord(partnerKey);
      const partnerExistingTask = cpuLoudnormMeasurementStore.getTask(partnerKey);
      if (!partnerExistingResult && !partnerExistingTask) {
        return startPairedCpuLoudnormTask(plan, partner, { key, partnerKey, background, queuedAt, opts });
      }
    }
    return startSingleCpuLoudnormTask(plan, { key, background, queuedAt, opts });
  };

  const getCpuLoudnormRecord = async (plan, parseLine) => {
    const key = cpuLoudnormKey(plan);
    const externalCached = !gpuFirstPassMeasure ? cachedCpuLoudnormForPlan(plan) : null;
    if (externalCached) {
      const result = { values: externalCached, wallSec: 0, source: "external_cached", waitSec: 0, queuedSec: 0, background: false };
      cpuLoudnormMeasurementStore.publishCached(key, result);
      return result;
    }
    const existingResult = cpuLoudnormMeasurementStore.getRecord(key);
    if (existingResult) return { ...existingResult, reused: true, waitSec: 0 };
    const existingTask = cpuLoudnormMeasurementStore.getTask(key);
    const task = existingTask || startCpuLoudnormTask(plan, { parseLine });
    const waitStartedAt = Date.now();
    const result = await task;
    const waitSec = (Date.now() - waitStartedAt) / 1000;
    const effectiveWaitSec = result.source === "fused_split_stats" ? 0 : waitSec;
    return (existingTask || result.source === "prefetched") ? { ...result, reused: true, waitSec: effectiveWaitSec } : { ...result, waitSec: effectiveWaitSec };
  };

  const knownCpuLoudnormValues = (plan) => {
    const cached = cachedCpuLoudnormForPlan(plan);
    return cpuLoudnormMeasurementStore.knownValuesForPlan(plan, cached);
  };

  const prefetchCpuLoudnormFrom = (afterPlanIdx, maxStarts = 1, reason = "while current GPU work runs") => {
    if (!useGpuSourcePort || maxStarts <= 0) return;
    let started = 0;
    for (let idx = afterPlanIdx; idx < processingPlans.length; idx += 1) {
      const nextPlan = processingPlans[idx];
      const key = cpuLoudnormKey(nextPlan);
      const externalCached = !gpuFirstPassMeasure ? cachedCpuLoudnormForPlan(nextPlan) : null;
      if (cpuLoudnormMeasurementStore.hasPendingOrReady(key) || externalCached) continue;
      if (shouldWaitForFusedProducer(nextPlan)) continue;
      args.jobLog(`GPU normalize scheduling CPU loudnorm prefetch for ${planLabelFor(nextPlan)} ${reason}`);
      startCpuLoudnormTask(nextPlan, { background: true });
      started += 1;
      if (started >= maxStarts) return;
    }
  };

  const prefetchNextCpuLoudnorm = (afterPlanIdx) => prefetchCpuLoudnormFrom(afterPlanIdx, 1);

  const cancelBackgroundCpu = () => {
    backgroundCpuGroup.cancelled = true;
    for (const proc of Array.from(backgroundCpuGroup.procs)) {
      terminateShellProcess(proc);
    }
  };

  const settleCpuLoudnormTasks = async () => {
    await Promise.allSettled(cpuLoudnormMeasurementStore.allTasks());
  };

  return {
    cancelBackgroundCpu,
    getCpuLoudnormRecord,
    knownCpuLoudnormValues,
    prefetchCpuLoudnormFrom,
    prefetchNextCpuLoudnorm,
    settleCpuLoudnormTasks,
    startCpuLoudnormTask,
  };
}

module.exports = {
  createCpuLoudnormScheduler,
};
