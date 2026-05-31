"use strict";

const {
  q,
} = require("./common");
const {
  buildPairedApplyShellScript,
} = require("./pairedApplyShellScript");
const {
  buildDecodeRelayCommands,
  buildDirectMuxRelayCommand,
  buildPipeSizerCommands,
} = require("./pairedApplyRelayCommands");

function buildDualDecodeCommand({
  ffmpegPath,
  sourceInput,
  sourceAudioIdx,
  originalRawFilter,
  originalFirstDecode,
  originalPlan,
  fallbackPlan,
  originalRate,
  fallbackRate,
  originalDecodeInput,
  fallbackDecodeInput,
  decodeFilterThreads,
}) {
  const filterGraph = `[0:a:${sourceAudioIdx}]asplit=2[orig_in][stereo_in];[orig_in]${originalRawFilter}[orig_raw];[stereo_in]aformat=channel_layouts=stereo[stereo_raw]`;
  const dualDecodeOutputs = originalFirstDecode ? [
    "-map", q("[orig_raw]"), "-ar", String(originalRate), "-f", q(originalPlan.rawInputFormat), q(originalDecodeInput),
    "-map", q("[stereo_raw]"), "-ar", String(fallbackRate), "-f", q(fallbackPlan.rawInputFormat), q(fallbackDecodeInput),
  ] : [
    "-map", q("[stereo_raw]"), "-ar", String(fallbackRate), "-f", q(fallbackPlan.rawInputFormat), q(fallbackDecodeInput),
    "-map", q("[orig_raw]"), "-ar", String(originalRate), "-f", q(originalPlan.rawInputFormat), q(originalDecodeInput),
  ];
  return [
    q(ffmpegPath), "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", q(sourceInput),
    ...(decodeFilterThreads > 0 ? ["-filter_threads", String(decodeFilterThreads)] : []),
    "-filter_complex", q(filterGraph),
    ...dualDecodeOutputs,
  ].join(" ");
}

module.exports = {
  buildDecodeRelayCommands,
  buildDirectMuxRelayCommand,
  buildDualDecodeCommand,
  buildPairedApplyShellScript,
  buildPipeSizerCommands,
};
