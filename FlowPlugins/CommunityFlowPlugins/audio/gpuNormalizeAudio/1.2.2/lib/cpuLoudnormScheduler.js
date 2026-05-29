"use strict";

function createCpuLoudnormScheduler({
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
}) {
  const startCpuLoudnormTask = (plan, opts = {}) => {
    const key = cpuLoudnormKey(plan);
    const existingResult = cpuLoudnormResults.get(key);
    if (existingResult) return Promise.resolve(existingResult);
    const existingTask = cpuLoudnormTasks.get(key);
    if (existingTask) return existingTask;
    const background = opts.background === true;
    const queuedAt = Date.now();
    if (gpuFirstPassMeasure) {
      return startGpuFirstPassTask(plan, { key, background, queuedAt, opts });
    }
    const partner = pairedCpuLoudnormPartner(plan);
    if (partner) {
      const partnerKey = cpuLoudnormKey(partner);
      const partnerExistingResult = cpuLoudnormResults.get(partnerKey);
      const partnerExistingTask = cpuLoudnormTasks.get(partnerKey);
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
      cpuLoudnormResults.set(key, result);
      return result;
    }
    const existingResult = cpuLoudnormResults.get(key);
    if (existingResult) return { ...existingResult, reused: true, waitSec: 0 };
    const existingTask = cpuLoudnormTasks.get(key);
    const task = existingTask || startCpuLoudnormTask(plan, { parseLine });
    const waitStartedAt = Date.now();
    const result = await task;
    const waitSec = (Date.now() - waitStartedAt) / 1000;
    const effectiveWaitSec = result.source === "fused_split_stats" ? 0 : waitSec;
    return (existingTask || result.source === "prefetched") ? { ...result, reused: true, waitSec: effectiveWaitSec } : { ...result, waitSec: effectiveWaitSec };
  };

  const knownCpuLoudnormValues = (plan) => {
    const cached = cachedCpuLoudnormForPlan(plan);
    return (cpuLoudnormResults.get(cpuLoudnormKey(plan)) || {}).values || cached;
  };

  const prefetchCpuLoudnormFrom = (afterPlanIdx, maxStarts = 1, reason = "while current GPU work runs") => {
    if (!useGpuSourcePort || maxStarts <= 0) return;
    let started = 0;
    for (let idx = afterPlanIdx; idx < processingPlans.length; idx += 1) {
      const nextPlan = processingPlans[idx];
      const key = cpuLoudnormKey(nextPlan);
      const externalCached = !gpuFirstPassMeasure ? cachedCpuLoudnormForPlan(nextPlan) : null;
      if (cpuLoudnormResults.has(key) || cpuLoudnormTasks.has(key) || externalCached) continue;
      if (canFuseAnyCpuLoudnormWithSplitStats(nextPlan)) continue;
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
      try { proc.kill("SIGTERM"); } catch (_) { /* noop */ }
    }
  };

  const settleCpuLoudnormTasks = async () => {
    await Promise.allSettled(Array.from(cpuLoudnormTasks.values()));
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
