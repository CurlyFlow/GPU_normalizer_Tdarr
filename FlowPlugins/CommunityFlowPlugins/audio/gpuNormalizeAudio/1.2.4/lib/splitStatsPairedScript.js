"use strict";

const path = require("path");

const {
  intNum,
  q,
} = require("./common");
const {
  buildPairedSplitStatsScriptVariant,
} = require("./splitStatsPairedScriptVariants");

const PAIRED_STATS_PLAN_SCHEMA = "gpuNormalizeAudio.pairedStatsPlan.v1";
const DEFAULT_RELAY_HELPER = path.join(__dirname, "..", "runtime", "bin", "paired_apply_relay.py");

function bufferedRelayMiB() {
  return Math.max(1, Math.min(2048, intNum(process.env.LOUDNORM_GPU_PAIR_FALLBACK_STATS_BUFFERED_DECODE_MIB, 256)));
}

function createPairedStatsPlan({ strategy }) {
  const topology = {
    fusePairedCpuMeasure: strategy.fusePairedCpuMeasure,
    bufferedDecode: strategy.bufferedDecode,
    singlePipe: strategy.singlePipe,
    singleRuntime: strategy.singleRuntime,
    stereoPrimary: strategy.stereoPrimary,
    stdoutPrimary: strategy.stdoutPrimary,
  };
  if (topology.singlePipe && topology.stdoutPrimary) throw new Error("paired split stats plan cannot use single_pipe and stdout_primary together");
  if (topology.bufferedDecode && (topology.singlePipe || topology.singleRuntime || topology.stdoutPrimary)) throw new Error("paired split stats buffered decode requires independent runtime FIFO topology");
  if (!topology.singleRuntime && (topology.singlePipe || topology.stereoPrimary)) throw new Error("paired split stats plan single-runtime topology flags require single_runtime");
  if (topology.fusePairedCpuMeasure && topology.stdoutPrimary) throw new Error("paired split stats plan cannot fuse CPU loudnorm with stdout_primary topology");
  return {
    schema: PAIRED_STATS_PLAN_SCHEMA,
    topology,
  };
}

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
  strategy,
  usesStereoFallbackSourcePath,
  buildStatsRuntimePlan,
  loudnormFilter,
}) {
  const pairedStatsPlan = createPairedStatsPlan({ strategy });
  const topology = pairedStatsPlan.topology;
  const fallbackRelayFifo = topology.bufferedDecode ? `${fallbackFifo}.relay` : fallbackFifo;
  const originalRelayFifo = topology.bufferedDecode ? `${originalFifo}.relay` : originalFifo;
  const relayBytes = String(bufferedRelayMiB() * 1024 * 1024);
  const pythonPath = args.pythonPath || "python3";
  const fallbackDecodeCommand = topology.stdoutPrimary ? ["__loudnorm_stdin__"] : ["cat", fallbackFifo];
  const originalDecodeCommand = ["cat", originalFifo];
  const combinedFilterGraph = topology.fusePairedCpuMeasure
    ? `[0:a:${plan.sourceAudioIdx}]asplit=2[orig_in][stereo_in];[orig_in]asplit=2[orig_measure_in][orig_raw_in];[orig_measure_in]${loudnormFilter()}[orig_measure_out];[orig_raw_in]aformat=channel_layouts=${partner.channelLayout}[orig_raw];[stereo_in]aformat=channel_layouts=stereo,asplit=2[stereo_raw][stereo_measure_in];[stereo_measure_in]${loudnormFilter()}[stereo_measure_out];[orig_raw][stereo_raw]amerge=inputs=2[paired_raw]`
    : `[0:a:${plan.sourceAudioIdx}]asplit=2[orig_in][stereo_in];[orig_in]aformat=channel_layouts=${partner.channelLayout}[orig_raw];[stereo_in]aformat=channel_layouts=stereo[stereo_raw];[orig_raw][stereo_raw]amerge=inputs=2[paired_raw]`;
  const combinedDecodeCommand = [
    args.ffmpegPath, "-hide_banner", ...(topology.fusePairedCpuMeasure ? [] : ["-loglevel", "error"]), "-nostats", "-nostdin", "-i", plan.sourceInput,
    "-filter_complex", combinedFilterGraph,
    "-map", "[paired_raw]", "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, "pipe:1",
    ...(topology.fusePairedCpuMeasure ? [
      "-map", "[orig_measure_out]", "-f", "null", (args.platform === "win32" ? "NUL" : "/dev/null"),
      "-map", "[stereo_measure_out]", "-f", "null", (args.platform === "win32" ? "NUL" : "/dev/null"),
    ] : []),
  ];
  const pairedStatsExtraArgs = topology.singleRuntime ? [
    "--paired-stats-decode-command-json", JSON.stringify(originalDecodeCommand),
    "--paired-stats-cache-output", partnerStatsCache,
    "--paired-stats-channels", String(partner.channels),
    "--paired-stats-rate", String(partnerStatsSampleRate),
    ...(usesStereoFallbackSourcePath(partner) ? ["--paired-stats-stereo-fallback-source-exact"] : []),
  ] : [];
  const originalPrimaryPairedStatsExtraArgs = topology.singleRuntime ? [
    "--paired-stats-decode-command-json", JSON.stringify(fallbackDecodeCommand),
    "--paired-stats-cache-output", statsCache,
    "--paired-stats-channels", String(plan.channels),
    "--paired-stats-rate", String(statsSampleRate),
    ...(topology.singlePipe ? [
      "--paired-stats-combined-decode-command-json", JSON.stringify(combinedDecodeCommand),
      "--paired-stats-combined-channels", String(partner.channels + plan.channels),
    ] : []),
    ...(usesStereoFallbackSourcePath(plan) ? ["--paired-stats-stereo-fallback-source-exact"] : []),
  ] : [];
  const fallbackStatsPlan = buildStatsRuntimePlan(plan, statsSampleRate, statsCache, fallbackDecodeCommand, pairedStatsExtraArgs);
  const originalStatsPlan = buildStatsRuntimePlan(partner, partnerStatsSampleRate, partnerStatsCache, originalDecodeCommand);
  const singleRuntimeStatsPlan = topology.singleRuntime
    ? (topology.stereoPrimary || topology.stdoutPrimary
      ? fallbackStatsPlan
      : buildStatsRuntimePlan(partner, partnerStatsSampleRate, partnerStatsCache, originalDecodeCommand, originalPrimaryPairedStatsExtraArgs))
    : fallbackStatsPlan;
  const filterGraph = topology.fusePairedCpuMeasure
    ? `[0:a:${plan.sourceAudioIdx}]asplit=2[orig_in][stereo_in];[orig_in]asplit=2[orig_measure_in][orig_raw_in];[orig_measure_in]${loudnormFilter()}[orig_measure_out];[orig_raw_in]aformat=channel_layouts=${partner.channelLayout}[orig_raw];[stereo_in]aformat=channel_layouts=stereo,asplit=2[stereo_raw][stereo_measure_in];[stereo_measure_in]${loudnormFilter()}[stereo_measure_out]`
    : `[0:a:${plan.sourceAudioIdx}]asplit=2[orig_in][stereo_in];[orig_in]aformat=channel_layouts=${partner.channelLayout}[orig_raw];[stereo_in]aformat=channel_layouts=stereo[stereo_raw]`;
  const ffmpegStatsDecodeOutputs = topology.stdoutPrimary ? [
    "-map", "[stereo_raw]", "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, "pipe:1",
    "-map", "[orig_raw]", "-ar", String(partnerStatsSampleRate), "-f", partner.rawInputFormat, q(originalFifo),
  ] : [
    "-map", "[stereo_raw]", "-ar", String(statsSampleRate), "-f", plan.rawInputFormat, q(fallbackRelayFifo),
    "-map", "[orig_raw]", "-ar", String(partnerStatsSampleRate), "-f", partner.rawInputFormat, q(originalRelayFifo),
  ];
  const ffmpegStatsDecodeBase = [
    q(args.ffmpegPath), "-hide_banner", ...(topology.fusePairedCpuMeasure ? [] : ["-loglevel", "error"]), "-nostats", "-nostdin", "-y", "-i", q(plan.sourceInput),
    "-filter_complex", q(filterGraph),
    ...ffmpegStatsDecodeOutputs,
    ...(topology.fusePairedCpuMeasure ? [
      "-map", "[orig_measure_out]", "-f", "null", (args.platform === "win32" ? "NUL" : "/dev/null"),
      "-map", "[stereo_measure_out]", "-f", "null", (args.platform === "win32" ? "NUL" : "/dev/null"),
    ] : []),
  ].join(" ");
  const ffmpegStatsDecode = topology.fusePairedCpuMeasure ? `${ffmpegStatsDecodeBase} 2> ${q(plan.measureErr)}` : ffmpegStatsDecodeBase;
  return buildPairedSplitStatsScriptVariant({
    fallbackFifo,
    fallbackRelayFifo,
    fallbackRelayCommand: topology.bufferedDecode ? `${q(pythonPath)} ${q(DEFAULT_RELAY_HELPER)} decode ${relayBytes} ${q(fallbackRelayFifo)} ${q(fallbackFifo)}` : "",
    fallbackStatsPlan,
    ffmpegStatsDecode,
    fusePairedCpuMeasure: topology.fusePairedCpuMeasure,
    originalFifo,
    originalRelayFifo,
    originalRelayCommand: topology.bufferedDecode ? `${q(pythonPath)} ${q(DEFAULT_RELAY_HELPER)} decode ${relayBytes} ${q(originalRelayFifo)} ${q(originalFifo)}` : "",
    originalStatsPlan,
    partnerStatsErr,
    plan,
    singleRuntimeStatsPlan,
    statsErr,
    useSinglePipe: topology.singlePipe,
    useSingleRuntime: topology.singleRuntime,
    useStdoutPrimary: topology.stdoutPrimary,
    useBufferedDecode: topology.bufferedDecode,
  });
}

module.exports = {
  buildPairedSplitStatsScript,
};
