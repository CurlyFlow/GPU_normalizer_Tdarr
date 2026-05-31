"use strict";

function createSplitStatsPolicy({
  splitStatsConfig,
  useGpuSourcePort,
  useStreamingSourcePort,
  gpuFirstPassMeasure,
  fallbackPlans,
  audioPlans,
  processingPlans,
  processingOrder,
  needsInlineStereoDownmix,
  usesStereoFallbackSourcePath,
}) {
  const {
    fuseOriginalMeasureStats,
    fuseStereoFallbackMeasureStats,
    pairStereoFallbackSplitStats,
    splitFallbackStatsEnabled,
    splitOriginalStatsEnabled,
    splitPrefetchNextStats,
  } = splitStatsConfig;

  const splitStatsKey = (plan, statsSampleRate) => `${plan.idx}:${plan.sourceIdx}:${plan.channels}:${statsSampleRate}`;
  const hasFallbackForPlan = (plan) => fallbackPlans.some((fallbackPlan) => fallbackPlan.sourceIdx === plan.sourceIdx);
  const canSplitStatsPlan = (plan) => useGpuSourcePort
    && useStreamingSourcePort
    && !gpuFirstPassMeasure
    && (plan.stereoFallback ? splitFallbackStatsEnabled : (splitOriginalStatsEnabled && hasFallbackForPlan(plan)));
  const canFuseCpuLoudnormWithSplitStats = (plan) => fuseStereoFallbackMeasureStats
    && canSplitStatsPlan(plan)
    && usesStereoFallbackSourcePath(plan);
  const canFuseOriginalCpuLoudnormWithSplitStats = (plan) => fuseOriginalMeasureStats
    && canSplitStatsPlan(plan)
    && !plan.stereoFallback
    && !needsInlineStereoDownmix(plan)
    && !!plan.channelLayout;
  const canFuseAnyCpuLoudnormWithSplitStats = (plan) => canFuseCpuLoudnormWithSplitStats(plan)
    || canFuseOriginalCpuLoudnormWithSplitStats(plan);
  const splitStatsNeedsMeasuredValues = (plan) => !plan.stereoFallback && plan.sourceSampleRate > 0;

  const pairedSplitStatsPartner = (plan) => {
    if (!pairStereoFallbackSplitStats || !plan.stereoFallback || !usesStereoFallbackSourcePath(plan)) return null;
    const partner = audioPlans.find((candidate) => !candidate.stereoFallback && candidate.sourceIdx === plan.sourceIdx);
    if (!partner || !canSplitStatsPlan(partner) || !partner.channelLayout) return null;
    if (partner.rawInputFormat !== plan.rawInputFormat || partner.rawGpuFormat !== plan.rawGpuFormat) return null;
    return partner;
  };

  const createPrefetchNextSplitStats = (startSplitStatsTask, { knownCpuLoudnormValues, startCpuLoudnormTask }) => (plan, reason) => {
    if (!splitPrefetchNextStats) return false;
    const currentOrder = processingOrder.get(plan.idx) || 0;
    for (let nextIdx = currentOrder + 1; nextIdx < processingPlans.length; nextIdx += 1) {
      const nextPlan = processingPlans[nextIdx];
      if (!canSplitStatsPlan(nextPlan)) continue;
      const nextCpuValues = knownCpuLoudnormValues(nextPlan);
      if (splitStatsNeedsMeasuredValues(nextPlan) && !nextCpuValues && !canFuseAnyCpuLoudnormWithSplitStats(nextPlan)) startCpuLoudnormTask(nextPlan, { background: true });
      startSplitStatsTask(nextPlan, reason, undefined, nextCpuValues || null);
      return true;
    }
    return false;
  };

  return {
    canFuseAnyCpuLoudnormWithSplitStats,
    canFuseCpuLoudnormWithSplitStats,
    canFuseOriginalCpuLoudnormWithSplitStats,
    canSplitStatsPlan,
    createPrefetchNextSplitStats,
    pairedSplitStatsPartner,
    splitStatsKey,
  };
}

module.exports = {
  createSplitStatsPolicy,
};
