"use strict";

const {
  createPairedSplitStatsTopology,
  pairedSplitStatsTopologyLogSuffix,
} = require("./splitStatsTopology");

function resolvePairedSplitStatsStrategy({
  splitStatsConfig,
  statsSampleRate,
  partnerStatsSampleRate,
  fusePairedCpuMeasure,
}) {
  const rawTeeCpuMeasure = splitStatsConfig.pairStereoFallbackSplitStatsRawTeeCpu && fusePairedCpuMeasure;
  const graphFusedCpuMeasure = fusePairedCpuMeasure && !rawTeeCpuMeasure;
  const singleRuntime = !rawTeeCpuMeasure && splitStatsConfig.pairStereoFallbackSplitStatsSingleRuntime && statsSampleRate === partnerStatsSampleRate;
  const singlePipe = singleRuntime && splitStatsConfig.pairStereoFallbackSplitStatsSinglePipe;
  const stdoutPrimary = !rawTeeCpuMeasure && !singlePipe && splitStatsConfig.pairStereoFallbackSplitStatsStdoutPrimary && !graphFusedCpuMeasure;
  const stereoPrimary = singleRuntime && !singlePipe && splitStatsConfig.pairStereoFallbackSplitStatsStereoPrimary;
  const bufferedDecode = !rawTeeCpuMeasure && splitStatsConfig.pairStereoFallbackSplitStatsBufferedDecode && !singleRuntime && !singlePipe && !stdoutPrimary;
  const topology = createPairedSplitStatsTopology({
    bufferedDecode,
    fusePairedCpuMeasure: graphFusedCpuMeasure,
    rawTeeCpuMeasure,
    singlePipe,
    singleRuntime,
    stereoPrimary,
    stdoutPrimary,
  });
  return {
    ...topology,
    topology,
    logSuffix() {
      return pairedSplitStatsTopologyLogSuffix(topology);
    },
  };
}

function resolveSplitStatsTaskMode({
  plan,
  cpuLoudnormKey,
  cpuLoudnormMeasurementStore,
  canFuseAnyCpuLoudnormWithSplitStats,
  canFuseOriginalCpuLoudnormWithSplitStats,
  pairedSplitStatsPartner,
  pairStereoFallbackSplitStatsFuseMeasure,
}) {
  const measureKey = cpuLoudnormKey(plan);
  const canFuseCpuMeasure = canFuseAnyCpuLoudnormWithSplitStats(plan)
    && !cpuLoudnormMeasurementStore.hasPendingOrReady(measureKey);
  const measureMode = !canFuseCpuMeasure
    ? { fused: false, kind: "none" }
    : canFuseOriginalCpuLoudnormWithSplitStats(plan)
      ? { fused: true, kind: "original" }
      : { fused: true, kind: "stereo_fallback" };
  const pairedPartner = pairedSplitStatsPartner(plan);
  const partnerMeasureKey = pairedPartner ? cpuLoudnormKey(pairedPartner) : null;
  const fusePairedCpuMeasure = measureMode.fused
    && pairStereoFallbackSplitStatsFuseMeasure
    && pairedPartner
    && canFuseOriginalCpuLoudnormWithSplitStats(pairedPartner)
    && !cpuLoudnormMeasurementStore.hasPendingOrReady(partnerMeasureKey);
  const partner = measureMode.fused && !fusePairedCpuMeasure ? null : pairedPartner;
  return {
    fuseCpuMeasure: measureMode.fused,
    fusePairedCpuMeasure,
    measureMode,
    measureKey,
    mode: partner ? "paired" : "single",
    partner,
    partnerMeasureKey,
  };
}

module.exports = {
  resolvePairedSplitStatsStrategy,
  resolveSplitStatsTaskMode,
};
