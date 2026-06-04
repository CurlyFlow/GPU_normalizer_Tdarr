"use strict";

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
  return {
    bufferedDecode,
    fusePairedCpuMeasure: graphFusedCpuMeasure,
    rawTeeCpuMeasure,
    singlePipe,
    singleRuntime,
    stereoPrimary,
    stdoutPrimary,
    logSuffix() {
      return [
        singleRuntime ? "single_runtime=true" : "",
        singlePipe ? "single_pipe=true" : "",
        bufferedDecode ? "buffered_decode=true" : "",
        stereoPrimary ? "stereo_primary=true" : "",
        stdoutPrimary ? "stdout_primary=true" : "",
        graphFusedCpuMeasure ? "fused_cpu_loudnorm=true" : "",
        rawTeeCpuMeasure ? "raw_tee_cpu_loudnorm=true" : "",
      ].filter(Boolean).map((flag) => ` ${flag}`).join("");
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
