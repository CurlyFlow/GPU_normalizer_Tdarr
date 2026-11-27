"use strict";

const {
  envFlag,
  num,
} = require("./common");

function pairStereoFallbackStatsStdoutPrimary(pairEnabled, singlePipe) {
  return pairEnabled && !singlePipe && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_STATS_STDOUT_PRIMARY");
}

function createSplitStatsConfig({
  args,
  fallbackPlans,
}) {
  const splitStatsDefault = fallbackPlans.length > 0;
  const splitFallbackStatsEnabled = envFlag("LOUDNORM_GPU_SPLIT_FALLBACK_STATS", splitStatsDefault);
  const splitOriginalStatsEnabled = envFlag("LOUDNORM_GPU_SPLIT_ORIGINAL_STATS", splitStatsDefault);
  const splitPrefetchNextStats = envFlag("LOUDNORM_GPU_SPLIT_PREFETCH_NEXT_STATS", splitStatsDefault);
  const splitPrefetchNextStatsDuringStats = splitPrefetchNextStats && envFlag("LOUDNORM_GPU_PREFETCH_NEXT_SPLIT_STATS_DURING_STATS", true);
  const splitPrefetchNextStatsAtProgress = splitPrefetchNextStats
    ? Math.max(0, Math.min(1, num(process.env.LOUDNORM_GPU_PREFETCH_NEXT_SPLIT_STATS_AT_PROGRESS, 0)))
    : 0;
  const fuseStereoFallbackMeasureStats = envFlag("LOUDNORM_GPU_STEREO_FALLBACK_FUSE_MEASURE_STATS", true);
  const fuseOriginalMeasureStats = envFlag("LOUDNORM_GPU_ORIGINAL_FUSE_MEASURE_STATS", false);
  const pairStereoFallbackSplitStatsBufferedDecode = envFlag("LOUDNORM_GPU_PAIR_FALLBACK_STATS_BUFFERED_DECODE") && args.platform !== "win32";
  const pairStereoFallbackSplitStatsRawTeeCpu = envFlag("LOUDNORM_GPU_PAIR_SPLIT_STATS_RAW_TEE_CPU") && args.platform !== "win32";
  const pairStereoFallbackSplitStats = (envFlag("LOUDNORM_GPU_PAIR_FALLBACK_STATS") || pairStereoFallbackSplitStatsBufferedDecode || pairStereoFallbackSplitStatsRawTeeCpu) && args.platform !== "win32";
  const pairStereoFallbackSplitStatsSingleRuntime = pairStereoFallbackSplitStats && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_STATS_SINGLE_RUNTIME");
  const pairStereoFallbackSplitStatsSinglePipe = pairStereoFallbackSplitStatsSingleRuntime && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_STATS_SINGLE_PIPE");
  const pairStereoFallbackSplitStatsFuseMeasure = pairStereoFallbackSplitStats && (envFlag("LOUDNORM_GPU_PAIR_FALLBACK_STATS_FUSE_MEASURE") || pairStereoFallbackSplitStatsBufferedDecode || pairStereoFallbackSplitStatsRawTeeCpu);
  const pairStereoFallbackSplitStatsStereoPrimary = pairStereoFallbackSplitStatsSingleRuntime && !pairStereoFallbackSplitStatsSinglePipe && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_STATS_STEREO_PRIMARY");
  const pairStereoFallbackSplitStatsStdoutPrimary = pairStereoFallbackStatsStdoutPrimary(pairStereoFallbackSplitStats, pairStereoFallbackSplitStatsSinglePipe);

  return {
    fuseOriginalMeasureStats,
    fuseStereoFallbackMeasureStats,
    pairStereoFallbackSplitStats,
    pairStereoFallbackSplitStatsBufferedDecode,
    pairStereoFallbackSplitStatsFuseMeasure,
    pairStereoFallbackSplitStatsRawTeeCpu,
    pairStereoFallbackSplitStatsSinglePipe,
    pairStereoFallbackSplitStatsSingleRuntime,
    pairStereoFallbackSplitStatsStdoutPrimary,
    pairStereoFallbackSplitStatsStereoPrimary,
    splitFallbackStatsEnabled,
    splitOriginalStatsEnabled,
    splitPrefetchNextStats,
    splitPrefetchNextStatsAtProgress,
    splitPrefetchNextStatsDuringStats,
  };
}

module.exports = {
  createSplitStatsConfig,
};
