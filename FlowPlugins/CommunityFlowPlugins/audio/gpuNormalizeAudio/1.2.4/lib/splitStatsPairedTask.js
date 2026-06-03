"use strict";

const {
  loudnormNumber,
  parseLoudnormJsonBlocksFromOutputs,
} = require("./common");
const {
  buildPairedSplitStatsScript,
} = require("./splitStatsPairedScript");
const {
  resolvePairedSplitStatsStrategy,
} = require("./splitStatsStrategy");

function createPairedSplitStatsTaskStarter({
  args,
  debugLogging,
  usesStereoFallbackSourcePath,
  processingSampleRateFor,
  trackStatsPaths,
  buildStatsRuntimePlan,
  loudnormFilter,
  runShell,
  planLabelFor,
  knownCpuLoudnormValues,
  cpuLoudnormMeasurementStore,
  cpuLoudnormKey,
  splitStatsKey,
  splitStatsResults,
  splitStatsTasks,
  splitStatsConfig,
}) {
  return (plan, partner, statsSampleRate, statsCache, statsErr, key, reason, parseLine, opts = {}) => {
    const fusePairedCpuMeasure = opts.fuseCpuMeasure === true;
    const partnerCpuValues = knownCpuLoudnormValues(partner);
    const partnerStatsSampleRate = processingSampleRateFor(partner, partnerCpuValues);
    const partnerKey = splitStatsKey(partner, partnerStatsSampleRate);
    if (splitStatsResults.has(partnerKey) || splitStatsTasks.has(partnerKey)) return null;
    const { statsCache: partnerStatsCache, statsErr: partnerStatsErr } = trackStatsPaths(partner, partnerStatsSampleRate);
    const fallbackFifo = `${plan.fifoInput}.stats`;
    const originalFifo = `${partner.fifoInput}.stats`;
    const strategy = resolvePairedSplitStatsStrategy({
      splitStatsConfig,
      statsSampleRate,
      partnerStatsSampleRate,
      fusePairedCpuMeasure,
    });
    const script = buildPairedSplitStatsScript({
      args,
      plan,
      partner,
      statsSampleRate,
      partnerStatsSampleRate,
      statsCache,
      partnerStatsCache,
      statsErr,
      partnerStatsErr,
      fallbackFifo,
      originalFifo,
      strategy,
      usesStereoFallbackSourcePath,
      buildStatsRuntimePlan,
      loudnormFilter,
    });
    args.jobLog(`GPU normalize paired split stats prepass enabled for ${planLabelFor(plan)} + ${planLabelFor(partner)} ${reason} rates=${statsSampleRate},${partnerStatsSampleRate}${strategy.logSuffix()}`);
    const pairTaskPromise = runShell(script, {
      args,
      label: `GPU paired streaming stats ${planLabelFor(plan)} + ${planLabelFor(partner)}`,
      allowedCodes: [0],
      capturePath: "",
      logOnSuccess: debugLogging,
      parseLine,
    }).then((res) => {
      if (res.code !== 0) throw new Error(`GPU paired streaming stats failed on ${planLabelFor(plan)} + ${planLabelFor(partner)}`);
      const result = { ...res, statsSampleRate, statsCache, pairedStats: true };
      const partnerResult = { ...res, statsSampleRate: partnerStatsSampleRate, statsCache: partnerStatsCache, pairedStats: true };
      if (fusePairedCpuMeasure) {
        const blocks = parseLoudnormJsonBlocksFromOutputs(res.output, [plan.measureErr, statsErr, partnerStatsErr]);
        if (blocks.length < 2) throw new Error("GPU normalize: paired fused stats CPU loudnorm did not produce two JSON blocks");
        const stereoValues = blocks[0];
        const originalValues = blocks[1];
        for (const values of [originalValues, stereoValues]) {
          for (const loudnormKey of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) loudnormNumber(values, loudnormKey);
        }
        const baseMeasureRecord = {
          wallSec: 0,
          source: "fused_split_stats",
          background: false,
          queuedSec: 0,
          fusedStatsSec: res.wallSec,
        };
        const originalMeasureRecord = { ...baseMeasureRecord, values: originalValues };
        const stereoMeasureRecord = { ...baseMeasureRecord, values: stereoValues };
        cpuLoudnormMeasurementStore.publishFused(partner, originalMeasureRecord);
        cpuLoudnormMeasurementStore.publishFused(plan, stereoMeasureRecord);
        result.cpuLoudnormRecord = stereoMeasureRecord;
        partnerResult.cpuLoudnormRecord = originalMeasureRecord;
        args.jobLog(`GPU normalize CPU loudnorm first pass ${planLabelFor(partner)} fused with paired split stats: ${JSON.stringify(originalValues)}`);
        args.jobLog(`GPU normalize CPU loudnorm first pass ${planLabelFor(plan)} fused with paired split stats: ${JSON.stringify(stereoValues)}`);
      }
      splitStatsResults.set(key, result);
      splitStatsResults.set(partnerKey, partnerResult);
      return { result, partnerResult };
    });
    const taskPromise = pairTaskPromise.then(({ result }) => result);
    const partnerTaskPromise = pairTaskPromise.then(({ partnerResult }) => partnerResult);
    const taskRecord = { promise: taskPromise, statsSampleRate, statsCache };
    const partnerTaskRecord = { promise: partnerTaskPromise, statsSampleRate: partnerStatsSampleRate, statsCache: partnerStatsCache };
    splitStatsTasks.set(key, taskRecord);
    splitStatsTasks.set(partnerKey, partnerTaskRecord);
    if (fusePairedCpuMeasure) {
      cpuLoudnormMeasurementStore.publishTask(plan, taskPromise.then((result) => result.cpuLoudnormRecord));
      cpuLoudnormMeasurementStore.publishTask(partner, partnerTaskPromise.then((result) => result.cpuLoudnormRecord));
    }
    return taskRecord;
  };
}

module.exports = {
  createPairedSplitStatsTaskStarter,
};
