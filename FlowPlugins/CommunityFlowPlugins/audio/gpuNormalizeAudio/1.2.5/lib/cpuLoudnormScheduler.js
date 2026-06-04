"use strict";

const {
  terminateShellProcess,
} = require("./shell");
const {
  envFlag,
} = require("./common");

function firstFulfilled(tasks) {
  return new Promise((resolve, reject) => {
    let pending = tasks.length;
    const errors = [];
    for (const task of tasks) {
      Promise.resolve(task).then(resolve, (err) => {
        errors.push(err);
        pending -= 1;
        if (pending === 0) reject(errors[0]);
      });
    }
  });
}

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
  const fusionRaceEnabled = !gpuFirstPassMeasure && useGpuSourcePort && envFlag("LOUDNORM_GPU_CPU_LOUDNORM_FUSION_RACE");
  const fusionRaceKey = (key) => `${key}:fusion_race`;
  const annotateFusionRaceResult = (result) => ({
    ...result,
    source: result.source === "paired_prefetched" ? "paired_fusion_race_cpu" : "fusion_race_cpu",
    background: true,
    fusionRace: true,
  });
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

  const startFusionRaceTask = (plan, reason = "while fused split stats can produce measurement") => {
    if (!fusionRaceEnabled || !shouldWaitForFusedProducer(plan)) return null;
    const key = cpuLoudnormKey(plan);
    const raceKey = fusionRaceKey(key);
    const existingResult = cpuLoudnormMeasurementStore.getRecord(raceKey);
    if (existingResult) return Promise.resolve(annotateFusionRaceResult(existingResult));
    const existingTask = cpuLoudnormMeasurementStore.getTask(raceKey);
    if (existingTask) return existingTask.then(annotateFusionRaceResult);
    const queuedAt = Date.now();
    args.jobLog(`GPU normalize scheduling CPU loudnorm fusion race for ${planLabelFor(plan)} ${reason}`);
    const partner = pairedCpuLoudnormPartner(plan);
    if (partner) {
      const partnerRaceKey = fusionRaceKey(cpuLoudnormKey(partner));
      const partnerExistingResult = cpuLoudnormMeasurementStore.getRecord(partnerRaceKey);
      const partnerExistingTask = cpuLoudnormMeasurementStore.getTask(partnerRaceKey);
      if (!partnerExistingResult && !partnerExistingTask) {
        return startPairedCpuLoudnormTask(plan, partner, {
          key: raceKey,
          partnerKey: partnerRaceKey,
          background: true,
          queuedAt,
          opts: {},
        }).then(annotateFusionRaceResult);
      }
    }
    return startSingleCpuLoudnormTask(plan, {
      key: raceKey,
      background: true,
      queuedAt,
      opts: {},
    }).then(annotateFusionRaceResult);
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
    const raceTask = startFusionRaceTask(plan);
    const waitStartedAt = Date.now();
    const result = raceTask
      ? await firstFulfilled([
        task,
        raceTask.then((raceResult) => {
          cpuLoudnormMeasurementStore.publishRecord(key, raceResult);
          return raceResult;
        }),
      ])
      : await task;
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
      if (shouldWaitForFusedProducer(nextPlan)) {
        const raceTask = startFusionRaceTask(nextPlan, reason);
        if (!raceTask) continue;
        started += 1;
        if (started >= maxStarts) return;
        continue;
      }
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
