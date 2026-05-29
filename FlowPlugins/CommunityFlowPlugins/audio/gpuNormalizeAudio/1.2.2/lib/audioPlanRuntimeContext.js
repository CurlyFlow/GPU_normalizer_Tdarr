"use strict";

const { q } = require("./common");
const {
  initializeAudioPlanRuntimeFields,
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
  const trackStatsPaths = (plan, statsSampleRate) => {
    const statsCache = statsCachePathFor(plan, statsSampleRate);
    const statsErr = statsErrPathFor(plan, statsSampleRate);
    if (!plan.statsCaches.includes(statsCache)) plan.statsCaches.push(statsCache);
    if (!plan.statsErrs.includes(statsErr)) plan.statsErrs.push(statsErr);
    return { statsCache, statsErr };
  };

  initializeAudioPlanRuntimeFields({
    audioPlans,
    sampleRate,
    durationSeconds,
    trackStatsPaths,
  });

  const audioWork = audioPlans.reduce((sum, plan) => sum + plan.work, 0);
  const muxWork = Math.max(1, audioWork * 0.03);
  const totalWork = audioWork + muxWork;
  const baselineEtaSeconds = Math.max(5, totalWork / 90);
  const cleanupFilesForPlan = (plan) => [plan.rawInput, plan.gains, ...(plan.statsCaches || [plan.statsCache]), plan.measureErr, ...(plan.statsErrs || [plan.statsErr]), plan.sourceErr, plan.rawGpu, plan.normalizedAudio, plan.fifoInput, plan.fifoOutput, `${plan.fifoInput}.stats`, `${plan.fifoOutput}.stats`];
  const allIntermediateFiles = audioPlans.flatMap(cleanupFilesForPlan);
  const cleanupAll = `rm -f ${[...allIntermediateFiles, tmpOutputFilePath].map(q).join(" ")}`;

  return {
    allIntermediateFiles,
    audioWork,
    baselineEtaSeconds,
    cleanupAll,
    cleanupFilesForPlan,
    muxWork,
    statsCachePathFor,
    statsErrPathFor,
    totalWork,
    trackStatsPaths,
  };
}

module.exports = {
  createAudioPlanRuntimeContext,
};
