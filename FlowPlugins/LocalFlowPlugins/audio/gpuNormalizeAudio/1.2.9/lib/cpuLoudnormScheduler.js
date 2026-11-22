"use strict";

const {
  cancelShellProcessGroup,
} = require("./shell");
const {
  envFlag,
} = require("./common");
const {
  createLoudnormMeasurementStore,
} = require("./loudnormMeasurementStore");

const CPU_LOUDNORM_PRODUCER = {
  FUSION_RACE: "fusionRace",
  PRIMARY: "primary",
};

function createCpuLoudnormProducers({ primaryStore, keyForPlan }) {
  const fusionRaceStore = createLoudnormMeasurementStore({ keyForPlan });
  const stores = {
    [CPU_LOUDNORM_PRODUCER.PRIMARY]: primaryStore,
    [CPU_LOUDNORM_PRODUCER.FUSION_RACE]: fusionRaceStore,
  };
  const storeFor = (producer) => stores[producer] || null;
  const stateFor = (producer, planOrKey) => {
    const store = storeFor(producer);
    if (!store) throw new Error(`unknown CPU loudnorm producer: ${producer}`);
    return {
      key: store.keyFor(planOrKey),
      record: store.getRecord(planOrKey),
      store,
      task: store.getTask(planOrKey),
    };
  };

  return {
    allTasks: () => Object.values(stores).flatMap((store) => store.allTasks()),
    fusionRaceStore,
    primaryStore,
    stateFor,
    storeFor,
  };
}

function createCpuLoudnormCandidate({ producer, reusedTask = false, task }) {
  return { producer, reusedTask, task };
}

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
  gpuFirstPassOriginalOnly,
  pairedCpuLoudnormPartner,
  planLabelFor,
  processingPlans,
  startGpuFirstPassTask,
  startPairedCpuLoudnormTask,
  startSingleCpuLoudnormTask,
  useGpuSourcePort,
}) {
  const shouldWaitForFusedProducer = cpuMeasurementAvailability.shouldWaitForFusedProducer || (() => false);
  const useGpuFirstPassForPlan = (plan) => gpuFirstPassMeasure && !(gpuFirstPassOriginalOnly && plan.stereoFallback);
  const fusedFirstPassForPlan = (plan) => envFlag("LOUDNORM_GPU_FUSED_FIRST_PASS") && !plan.stereoFallback;
  const fusionRaceEnabled = !gpuFirstPassMeasure && useGpuSourcePort && envFlag("LOUDNORM_GPU_CPU_LOUDNORM_FUSION_RACE");
  const producers = createCpuLoudnormProducers({
    primaryStore: cpuLoudnormMeasurementStore,
    keyForPlan: cpuLoudnormKey,
  });
  const annotateFusionRaceResult = (result) => ({
    ...result,
    source: result.source === "paired_prefetched" ? "paired_fusion_race_cpu" : "fusion_race_cpu",
    background: true,
    fusionRace: true,
  });
  const startCpuLoudnormTask = (plan, opts = {}) => {
    if (backgroundCpuGroup.cancelled) return Promise.reject(new Error("GPU normalize job work was cancelled"));
    const key = cpuLoudnormKey(plan);
    const existingResult = fusedFirstPassForPlan(plan) ? null : cpuLoudnormMeasurementStore.getRecord(key);
    if (existingResult) return Promise.resolve(existingResult);
    const existingTask = cpuLoudnormMeasurementStore.getTask(key);
    if (existingTask) return existingTask;
    const background = opts.background === true;
    const queuedAt = Date.now();
    if (useGpuFirstPassForPlan(plan)) {
      return startGpuFirstPassTask(plan, {
        key,
        background,
        queuedAt,
        opts,
      });
    }
    const partner = gpuFirstPassOriginalOnly ? null : pairedCpuLoudnormPartner(plan);
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
    if (backgroundCpuGroup.cancelled) return null;
    if (!fusionRaceEnabled || !shouldWaitForFusedProducer(plan)) return null;
    const { key, record: existingResult, task: existingTask, store } = producers.stateFor(CPU_LOUDNORM_PRODUCER.FUSION_RACE, plan);
    if (existingResult) return Promise.resolve(annotateFusionRaceResult(existingResult));
    if (existingTask) return existingTask.then(annotateFusionRaceResult);
    const queuedAt = Date.now();
    args.jobLog(`GPU normalize scheduling CPU loudnorm fusion race for ${planLabelFor(plan)} ${reason}`);
    const partner = pairedCpuLoudnormPartner(plan);
    if (partner) {
      const { key: partnerKey, record: partnerExistingResult, task: partnerExistingTask } = producers.stateFor(CPU_LOUDNORM_PRODUCER.FUSION_RACE, partner);
      if (!partnerExistingResult && !partnerExistingTask) {
        return startPairedCpuLoudnormTask(plan, partner, {
          key,
          partnerKey,
          background: true,
          queuedAt,
          measurementStore: store,
          opts: {},
        }).then(annotateFusionRaceResult);
      }
    }
    return startSingleCpuLoudnormTask(plan, {
      key,
      background: true,
      queuedAt,
      measurementStore: store,
      opts: {},
    }).then(annotateFusionRaceResult);
  };

  const createPrimaryCandidate = (plan, parseLine) => {
    const existingTask = cpuLoudnormMeasurementStore.getTask(plan);
    return createCpuLoudnormCandidate({
      producer: CPU_LOUDNORM_PRODUCER.PRIMARY,
      reusedTask: Boolean(existingTask),
      task: existingTask || startCpuLoudnormTask(plan, { parseLine }),
    });
  };

  const createFusionRaceCandidate = (plan) => {
    const task = startFusionRaceTask(plan);
    return task ? createCpuLoudnormCandidate({ producer: CPU_LOUDNORM_PRODUCER.FUSION_RACE, task }) : null;
  };

  const waitForCpuLoudnormCandidate = async (plan, candidates) => {
    if (candidates.length === 1) return await candidates[0].task;
    return await firstFulfilled(candidates.map((candidate) => {
      if (candidate.producer !== CPU_LOUDNORM_PRODUCER.FUSION_RACE) return candidate.task;
      return candidate.task.then((raceResult) => {
        cpuLoudnormMeasurementStore.publishRecord(plan, raceResult);
        return raceResult;
      });
    }));
  };

  const getCpuLoudnormRecord = async (plan, parseLine) => {
    const key = cpuLoudnormKey(plan);
    const externalCached = !useGpuFirstPassForPlan(plan) ? cachedCpuLoudnormForPlan(plan) : null;
    if (externalCached) {
      const result = { values: externalCached, wallSec: 0, source: "external_cached", waitSec: 0, queuedSec: 0, background: false };
      cpuLoudnormMeasurementStore.publishCached(key, result);
      return result;
    }
    const existingResult = fusedFirstPassForPlan(plan) ? null : cpuLoudnormMeasurementStore.getRecord(key);
    if (existingResult) return { ...existingResult, reused: true, waitSec: 0 };
    const candidates = [createPrimaryCandidate(plan, parseLine)];
    const raceCandidate = createFusionRaceCandidate(plan);
    if (raceCandidate) candidates.push(raceCandidate);
    const waitStartedAt = Date.now();
    const result = await waitForCpuLoudnormCandidate(plan, candidates);
    const waitSec = (Date.now() - waitStartedAt) / 1000;
    const effectiveWaitSec = result.source === "fused_split_stats" ? 0 : waitSec;
    return (candidates[0].reusedTask || result.source === "prefetched") ? { ...result, reused: true, waitSec: effectiveWaitSec } : { ...result, waitSec: effectiveWaitSec };
  };

  const knownCpuLoudnormValues = (plan) => {
    const cached = cachedCpuLoudnormForPlan(plan);
    return cpuLoudnormMeasurementStore.knownValuesForPlan(plan, cached);
  };

  const prefetchCpuLoudnormFrom = (afterPlanIdx, maxStarts = 1, reason = "while current GPU work runs") => {
    if (backgroundCpuGroup.cancelled || !useGpuSourcePort || maxStarts <= 0) return 0;
    let started = 0;
    for (let idx = afterPlanIdx; idx < processingPlans.length; idx += 1) {
      const nextPlan = processingPlans[idx];
      const key = cpuLoudnormKey(nextPlan);
      const externalCached = !useGpuFirstPassForPlan(nextPlan) ? cachedCpuLoudnormForPlan(nextPlan) : null;
      if (cpuLoudnormMeasurementStore.hasPendingOrReady(key) || externalCached) continue;
      if (shouldWaitForFusedProducer(nextPlan)) {
        const raceTask = startFusionRaceTask(nextPlan, reason);
        if (!raceTask) continue;
        started += 1;
        if (started >= maxStarts) return started;
        continue;
      }
      args.jobLog(`GPU normalize scheduling CPU loudnorm prefetch for ${planLabelFor(nextPlan)} ${reason}`);
      startCpuLoudnormTask(nextPlan, { background: true });
      started += 1;
      if (started >= maxStarts) return started;
    }
    return started;
  };

  const prefetchNextCpuLoudnorm = (afterPlanIdx) => prefetchCpuLoudnormFrom(afterPlanIdx, 1);

  const cancelBackgroundCpu = () => {
    cancelShellProcessGroup(backgroundCpuGroup);
  };

  const settleCpuLoudnormTasks = async () => {
    await Promise.allSettled(producers.allTasks());
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
