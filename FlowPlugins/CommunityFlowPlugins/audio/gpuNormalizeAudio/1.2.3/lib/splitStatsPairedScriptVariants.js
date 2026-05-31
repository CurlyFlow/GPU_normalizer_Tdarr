"use strict";

const {
  q,
} = require("./common");

function buildPairedSplitStatsScriptVariant({
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
}) {
  if (useSinglePipe) {
    return [
      `rm -f ${q(statsErr)} ${q(partnerStatsErr)}${fusePairedCpuMeasure ? ` ${q(plan.measureErr)}` : ""}`,
      `(${singleRuntimeStatsPlan}) 2>&1 | tee -a ${q(statsErr)} ${q(partnerStatsErr)}`,
    ].join("\n");
  }

  if (useStdoutPrimary && useSingleRuntime) {
    return [
      "set -o pipefail",
      `rm -f ${q(originalFifo)} ${q(statsErr)} ${q(partnerStatsErr)}`,
      `mkfifo ${q(originalFifo)}`,
      `cleanup(){ rm -f ${q(originalFifo)}; }`,
      `trap cleanup EXIT`,
      `${ffmpegStatsDecode} | (${singleRuntimeStatsPlan}) 2>&1 | tee -a ${q(statsErr)} ${q(partnerStatsErr)}`,
      `pipeline_code=$?`,
      `trap - EXIT`,
      `cleanup`,
      `if [ "$pipeline_code" -ne 0 ]; then exit "$pipeline_code"; fi`,
    ].join("\n");
  }

  if (useStdoutPrimary) {
    return [
      "set -o pipefail",
      `rm -f ${q(originalFifo)} ${q(statsErr)} ${q(partnerStatsErr)}`,
      `mkfifo ${q(originalFifo)}`,
      `pids=""`,
      `cleanup(){ for p in $pids; do kill "$p" 2>/dev/null || true; done; rm -f ${q(originalFifo)}; }`,
      `trap cleanup EXIT`,
      `(${originalStatsPlan}) 2>&1 | tee -a ${q(partnerStatsErr)} & pid_orig=$!; pids="$pids $pid_orig"`,
      `${ffmpegStatsDecode} | (${fallbackStatsPlan}) 2>&1 | tee -a ${q(statsErr)}`,
      `pipeline_code=$?`,
      `if [ "$pipeline_code" -ne 0 ]; then kill "$pid_orig" 2>/dev/null || true; wait "$pid_orig" 2>/dev/null; exit "$pipeline_code"; fi`,
      `wait "$pid_orig"; orig_code=$?`,
      `trap - EXIT`,
      `rm -f ${q(originalFifo)}`,
      `if [ "$orig_code" -ne 0 ]; then exit "$orig_code"; fi`,
    ].join("\n");
  }

  if (useSingleRuntime) {
    return [
      `rm -f ${q(fallbackFifo)} ${q(originalFifo)} ${q(statsErr)} ${q(partnerStatsErr)}${fusePairedCpuMeasure ? ` ${q(plan.measureErr)}` : ""}`,
      `mkfifo ${q(fallbackFifo)} ${q(originalFifo)}`,
      `pids=""`,
      `cleanup(){ for p in $pids; do kill "$p" 2>/dev/null || true; done; rm -f ${q(fallbackFifo)} ${q(originalFifo)}; }`,
      `trap cleanup EXIT`,
      `(${singleRuntimeStatsPlan}) 2>&1 | tee -a ${q(statsErr)} ${q(partnerStatsErr)} & pid_pair=$!; pids="$pids $pid_pair"`,
      `${ffmpegStatsDecode}`,
      `ffmpeg_code=$?`,
      `if [ "$ffmpeg_code" -ne 0 ]; then kill "$pid_pair" 2>/dev/null || true; wait "$pid_pair" 2>/dev/null; exit "$ffmpeg_code"; fi`,
      `wait "$pid_pair"; pair_code=$?`,
      `if [ "$pair_code" -ne 0 ]; then exit "$pair_code"; fi`,
    ].join("\n");
  }

  return [
    `rm -f ${q(fallbackFifo)} ${q(originalFifo)} ${q(statsErr)} ${q(partnerStatsErr)}${fusePairedCpuMeasure ? ` ${q(plan.measureErr)}` : ""}`,
    `mkfifo ${q(fallbackFifo)} ${q(originalFifo)}`,
    `pids=""`,
    `cleanup(){ for p in $pids; do kill "$p" 2>/dev/null || true; done; rm -f ${q(fallbackFifo)} ${q(originalFifo)}; }`,
    `trap cleanup EXIT`,
    `(${fallbackStatsPlan}) 2>&1 | tee -a ${q(statsErr)} & pid_fb=$!; pids="$pids $pid_fb"`,
    `(${originalStatsPlan}) 2>&1 | tee -a ${q(partnerStatsErr)} & pid_orig=$!; pids="$pids $pid_orig"`,
    `${ffmpegStatsDecode}`,
    `ffmpeg_code=$?`,
    `if [ "$ffmpeg_code" -ne 0 ]; then kill "$pid_fb" "$pid_orig" 2>/dev/null || true; wait "$pid_fb" 2>/dev/null; wait "$pid_orig" 2>/dev/null; exit "$ffmpeg_code"; fi`,
    `wait "$pid_fb"; fb_code=$?`,
    `wait "$pid_orig"; orig_code=$?`,
    `if [ "$fb_code" -ne 0 ]; then exit "$fb_code"; fi`,
    `if [ "$orig_code" -ne 0 ]; then exit "$orig_code"; fi`,
  ].join("\n");
}

module.exports = {
  buildPairedSplitStatsScriptVariant,
};
