"use strict";

const { q } = require("./common");
const {
  createAudioRuntimePlans,
} = require("./audioPlanConstruction");

function createAudioPlanRuntimeContext({
  audioPlans,
  sampleRate,
  durationSeconds,
  tmpOutputFilePath,
}) {
  const statsCachePathFor = (plan, statsSampleRate) => statsSampleRate === sampleRate
    ? plan.statsCache
    : plan.statsCache.replace(/\.stats\.bin$/, `.r${statsSampleRate}.stats.bin`);
  const statsErrPathFor = (plan, statsSampleRate) => statsSampleRate === sampleRate
    ? plan.statsErr
    : plan.statsErr.replace(/\.stats\.err$/, `.r${statsSampleRate}.stats.err`);
  const runtimePlans = createAudioRuntimePlans({
    audioPlans,
    sampleRate,
    durationSeconds,
    statsCachePathFor,
    statsErrPathFor,
  });
  const trackedStatsCaches = new Map(runtimePlans.map((plan) => [plan, new Set(plan.statsCaches)]));
  const trackedStatsErrs = new Map(runtimePlans.map((plan) => [plan, new Set(plan.statsErrs)]));

  const trackStatsCachePath = (plan, statsCache) => {
    const caches = trackedStatsCaches.get(plan);
    if (caches) caches.add(statsCache);
    return statsCache;
  };
  const trackStatsErrPath = (plan, statsErr) => {
    const errs = trackedStatsErrs.get(plan);
    if (errs) errs.add(statsErr);
    return statsErr;
  };
  const trackStatsPaths = (plan, statsSampleRate) => {
    const statsCache = statsCachePathFor(plan, statsSampleRate);
    const statsErr = statsErrPathFor(plan, statsSampleRate);
    trackStatsCachePath(plan, statsCache);
    trackStatsErrPath(plan, statsErr);
    return { statsCache, statsErr };
  };

  const audioWork = runtimePlans.reduce((sum, plan) => sum + plan.work, 0);
  const muxWork = Math.max(1, audioWork * 0.03);
  const totalWork = audioWork + muxWork;
  const baselineEtaSeconds = Math.max(5, totalWork / 90);
  const firstPassStatsCacheFor = (statsCache) => statsCache.replace(/\.stats\.bin$/, ".first-pass.stats.bin");
  const statsCachesForCleanup = (plan) => [...(trackedStatsCaches.get(plan) || new Set(plan.statsCaches || [plan.statsCache]))];
  const statsErrsForCleanup = (plan) => [...(trackedStatsErrs.get(plan) || new Set(plan.statsErrs || [plan.statsErr]))];
  const cleanupFilesForPlan = (plan) => [
    plan.rawInput,
    plan.gains,
    ...statsCachesForCleanup(plan),
    ...statsCachesForCleanup(plan).map(firstPassStatsCacheFor),
    plan.measureErr,
    ...statsErrsForCleanup(plan),
    plan.sourceErr,
    plan.rawGpu,
    plan.normalizedAudio,
    plan.fifoInput,
    plan.fifoOutput,
    `${plan.fifoInput}.stats`,
    `${plan.fifoOutput}.stats`,
  ];
  const allIntermediateFiles = runtimePlans.flatMap(cleanupFilesForPlan);
  const cleanupAll = `rm -f ${[...allIntermediateFiles, tmpOutputFilePath].map(q).join(" ")}`;

  return {
    allIntermediateFiles,
    audioPlans: runtimePlans,
    audioWork,
    baselineEtaSeconds,
    cleanupAll,
    cleanupFilesForPlan,
    muxWork,
    statsCachePathFor,
    statsErrPathFor,
    totalWork,
    trackStatsCachePath,
    trackStatsPaths,
  };
}

module.exports = {
  createAudioPlanRuntimeContext,
};
