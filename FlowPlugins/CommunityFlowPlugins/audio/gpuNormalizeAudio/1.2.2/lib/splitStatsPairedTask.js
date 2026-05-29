"use strict";

const fs = require("fs");
const {
  loudnormNumber,
  parseLoudnormJsonBlocks,
} = require("./common");
const {
  buildPairedSplitStatsScript,
} = require("./splitStatsPairedScript");

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
  cpuLoudnormResults,
  cpuLoudnormTasks,
  cpuLoudnormKey,
  splitStatsKey,
  splitStatsResults,
  splitStatsTasks,
  pairStereoFallbackSplitStatsSingleRuntime,
  pairStereoFallbackSplitStatsSinglePipe,
  pairStereoFallbackSplitStatsStdoutPrimary,
  pairStereoFallbackSplitStatsStereoPrimary,
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
    const useSingleRuntime = pairStereoFallbackSplitStatsSingleRuntime && statsSampleRate === partnerStatsSampleRate;
    const useSinglePipe = useSingleRuntime && pairStereoFallbackSplitStatsSinglePipe;
    const useStdoutPrimary = !useSinglePipe && pairStereoFallbackSplitStatsStdoutPrimary && !fusePairedCpuMeasure;
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
      useSingleRuntime,
      useSinglePipe,
      useStdoutPrimary,
      fusePairedCpuMeasure,
      pairStereoFallbackSplitStatsStereoPrimary,
      usesStereoFallbackSourcePath,
      buildStatsRuntimePlan,
      loudnormFilter,
    });
    args.jobLog(`GPU normalize paired split stats prepass enabled for ${planLabelFor(plan)} + ${planLabelFor(partner)} ${reason} rates=${statsSampleRate},${partnerStatsSampleRate}${useSingleRuntime ? " single_runtime=true" : ""}${useSinglePipe ? " single_pipe=true" : ""}${pairStereoFallbackSplitStatsStereoPrimary ? " stereo_primary=true" : ""}${useStdoutPrimary ? " stdout_primary=true" : ""}${fusePairedCpuMeasure ? " fused_cpu_loudnorm=true" : ""}`);
    const pairTask = runShell(script, {
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
        let loudnormText = res.output;
        for (const loudnormPath of [plan.measureErr, statsErr, partnerStatsErr]) {
          if (fs.existsSync(loudnormPath)) loudnormText += `\n${fs.readFileSync(loudnormPath, "utf8")}`;
        }
        const blocks = parseLoudnormJsonBlocks(loudnormText);
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
        cpuLoudnormResults.set(cpuLoudnormKey(partner), originalMeasureRecord);
        cpuLoudnormResults.set(cpuLoudnormKey(plan), stereoMeasureRecord);
        result.cpuLoudnormRecord = stereoMeasureRecord;
        partnerResult.cpuLoudnormRecord = originalMeasureRecord;
        args.jobLog(`GPU normalize CPU loudnorm first pass ${planLabelFor(partner)} fused with paired split stats: ${JSON.stringify(originalValues)}`);
        args.jobLog(`GPU normalize CPU loudnorm first pass ${planLabelFor(plan)} fused with paired split stats: ${JSON.stringify(stereoValues)}`);
      }
      splitStatsResults.set(key, result);
      splitStatsResults.set(partnerKey, partnerResult);
      return { result, partnerResult };
    });
    const task = pairTask.then(({ result }) => result);
    task.statsSampleRate = statsSampleRate;
    task.statsCache = statsCache;
    const partnerTask = pairTask.then(({ partnerResult }) => partnerResult);
    partnerTask.statsSampleRate = partnerStatsSampleRate;
    partnerTask.statsCache = partnerStatsCache;
    splitStatsTasks.set(key, task);
    splitStatsTasks.set(partnerKey, partnerTask);
    if (fusePairedCpuMeasure) {
      cpuLoudnormTasks.set(cpuLoudnormKey(plan), task.then((result) => result.cpuLoudnormRecord));
      cpuLoudnormTasks.set(cpuLoudnormKey(partner), partnerTask.then((result) => result.cpuLoudnormRecord));
    }
    return task;
  };
}

module.exports = {
  createPairedSplitStatsTaskStarter,
};
