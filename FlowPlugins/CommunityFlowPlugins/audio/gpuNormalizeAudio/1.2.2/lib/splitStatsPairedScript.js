"use strict";

const {
  q,
} = require("./common");
const {
  buildPairedSplitStatsScriptVariant,
} = require("./splitStatsPairedScriptVariants");

function buildPairedSplitStatsScript({
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
}) {
  const fallbackDecodeCommand = useStdoutPrimary ? ["__loudnorm_stdin__"] : ["cat", fallbackFifo];
  const originalDecodeCommand = ["cat", originalFifo];
  const combinedFilterGraph = fusePairedCpuMeasure
    ? `[0:a:${plan.sourceAudioIdx}]asplit=2[orig_in][stereo_in];[orig_in]asplit=2[orig_measure_in][orig_raw_in];[orig_measure_in]${loudnormFilter()}[orig_measure_out];[orig_raw_in]aformat=channel_layouts=${partner.channelLayout}[orig_raw];[stereo_in]aformat=channel_layouts=stereo,asplit=2[stereo_raw][stereo_measure_in];[stereo_measure_in]${loudnormFilter()}[stereo_measure_out];[orig_raw][stereo_raw]amerge=inputs=2[paired_raw]`
    : `[0:a:${plan.sourceAudioIdx}]asplit=2[orig_in][stereo_in];[orig_in]aformat=channel_layouts=${partner.channelLayout}[orig_raw];[stereo_in]aformat=channel_layouts=stereo[stereo_raw];[orig_raw][stereo_raw]amerge=inputs=2[paired_raw]`;
  const combinedDecodeCommand = [
    args.ffmpegPath, "-hide_banner", ...(fusePairedCpuMeasure ? [] : ["-loglevel", "error"]), "-nostats", "-nostdin", "-i", plan.sourceInput,
    "-filter_complex", combinedFilterGraph,
    "-map", "[paired_raw]", "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, "pipe:1",
    ...(fusePairedCpuMeasure ? [
      "-map", "[orig_measure_out]", "-f", "null", (args.platform === "win32" ? "NUL" : "/dev/null"),
      "-map", "[stereo_measure_out]", "-f", "null", (args.platform === "win32" ? "NUL" : "/dev/null"),
    ] : []),
  ];
  const pairedStatsExtraArgs = useSingleRuntime ? [
    "--paired-stats-decode-command-json", q(JSON.stringify(originalDecodeCommand)),
    "--paired-stats-cache-output", q(partnerStatsCache),
    "--paired-stats-channels", String(partner.channels),
    "--paired-stats-rate", String(partnerStatsSampleRate),
    ...(usesStereoFallbackSourcePath(partner) ? ["--paired-stats-stereo-fallback-source-exact"] : []),
  ] : [];
  const originalPrimaryPairedStatsExtraArgs = useSingleRuntime ? [
    "--paired-stats-decode-command-json", q(JSON.stringify(fallbackDecodeCommand)),
    "--paired-stats-cache-output", q(statsCache),
    "--paired-stats-channels", String(plan.channels),
    "--paired-stats-rate", String(statsSampleRate),
    ...(useSinglePipe ? [
      "--paired-stats-combined-decode-command-json", q(JSON.stringify(combinedDecodeCommand)),
      "--paired-stats-combined-channels", String(partner.channels + plan.channels),
    ] : []),
    ...(usesStereoFallbackSourcePath(plan) ? ["--paired-stats-stereo-fallback-source-exact"] : []),
  ] : [];
  const fallbackStatsPlan = buildStatsRuntimePlan(plan, statsSampleRate, statsCache, fallbackDecodeCommand, pairedStatsExtraArgs);
  const originalStatsPlan = buildStatsRuntimePlan(partner, partnerStatsSampleRate, partnerStatsCache, originalDecodeCommand);
  const singleRuntimeStatsPlan = useSingleRuntime
    ? (pairStereoFallbackSplitStatsStereoPrimary || useStdoutPrimary
      ? fallbackStatsPlan
      : buildStatsRuntimePlan(partner, partnerStatsSampleRate, partnerStatsCache, originalDecodeCommand, originalPrimaryPairedStatsExtraArgs))
    : fallbackStatsPlan;
  const filterGraph = fusePairedCpuMeasure
    ? `[0:a:${plan.sourceAudioIdx}]asplit=2[orig_in][stereo_in];[orig_in]asplit=2[orig_measure_in][orig_raw_in];[orig_measure_in]${loudnormFilter()}[orig_measure_out];[orig_raw_in]aformat=channel_layouts=${partner.channelLayout}[orig_raw];[stereo_in]aformat=channel_layouts=stereo,asplit=2[stereo_raw][stereo_measure_in];[stereo_measure_in]${loudnormFilter()}[stereo_measure_out]`
    : `[0:a:${plan.sourceAudioIdx}]asplit=2[orig_in][stereo_in];[orig_in]aformat=channel_layouts=${partner.channelLayout}[orig_raw];[stereo_in]aformat=channel_layouts=stereo[stereo_raw]`;
  const ffmpegStatsDecodeOutputs = useStdoutPrimary ? [
    "-map", "[stereo_raw]", "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, "pipe:1",
    "-map", "[orig_raw]", "-ar", String(partnerStatsSampleRate), "-f", partner.rawInputFormat, q(originalFifo),
  ] : [
    "-map", "[stereo_raw]", "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, q(fallbackFifo),
    "-map", "[orig_raw]", "-ar", String(partnerStatsSampleRate), "-f", partner.rawInputFormat, q(originalFifo),
  ];
  const ffmpegStatsDecodeBase = [
    q(args.ffmpegPath), "-hide_banner", ...(fusePairedCpuMeasure ? [] : ["-loglevel", "error"]), "-nostats", "-nostdin", "-y", "-i", q(plan.sourceInput),
    "-filter_complex", q(filterGraph),
    ...ffmpegStatsDecodeOutputs,
    ...(fusePairedCpuMeasure ? [
      "-map", "[orig_measure_out]", "-f", "null", (args.platform === "win32" ? "NUL" : "/dev/null"),
      "-map", "[stereo_measure_out]", "-f", "null", (args.platform === "win32" ? "NUL" : "/dev/null"),
    ] : []),
  ].join(" ");
  const ffmpegStatsDecode = fusePairedCpuMeasure ? `${ffmpegStatsDecodeBase} 2> ${q(plan.measureErr)}` : ffmpegStatsDecodeBase;
  return buildPairedSplitStatsScriptVariant({
    fallbackFifo,
    fallbackStatsPlan,
    ffmpegStatsDecode,
    fusePairedCpuMeasure,
    originalFifo,
    originalStatsPlan,
    partnerStatsErr,
    plan,
    singleRuntimeStatsPlan,
    statsErr,
    useSinglePipe,
    useSingleRuntime,
    useStdoutPrimary,
  });
}

module.exports = {
  buildPairedSplitStatsScript,
};
