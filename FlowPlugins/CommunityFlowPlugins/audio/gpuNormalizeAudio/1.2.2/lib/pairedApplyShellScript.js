"use strict";

const {
  q,
} = require("./common");
const {
  buildDualRuntimePairedApplyShellScript,
  buildSingleRuntimePairedApplyShellScript,
} = require("./pairedApplyShellVariants");

function buildPairShellProfilePreamble({ enabled, fallbackPlan, originalPlan }) {
  return enabled ? [
    "profile_now_ns(){ date +%s%N; }",
    "profile_elapsed(){ local d=$(( $(profile_now_ns) - $1 )); printf '%d.%09d' \"$((d/1000000000))\" \"$((d%1000000000))\"; }",
    `pair_profile_fields=${q(`stream=${fallbackPlan.idx} partner_stream=${originalPlan.idx} source_stream=${fallbackPlan.sourceIdx} channels=${fallbackPlan.channels}+${originalPlan.channels}`)}`,
    "profile_stage_emit(){ local name=\"$1\"; local start=\"$2\"; shift 2; printf 'profile_stage scope=plugin name=%s wall_sec=%s %s %s\\n' \"$name\" \"$(profile_elapsed \"$start\")\" \"$pair_profile_fields\" \"$*\" >&2; }",
    "pair_shell_start_ns=$(profile_now_ns)",
  ] : [];
}

function pairProfilePrefix(enabled, name) {
  return enabled ? `${name}_start_ns=$(profile_now_ns)\n` : "";
}

function buildRuntimeLaunchCommand({ shellProfile, profileName, command, sourceErr, noTee, pidName }) {
  const prefix = pairProfilePrefix(shellProfile, profileName);
  return noTee
    ? `${prefix}(${command}) >> ${q(sourceErr)} 2>&1 & pids+=("$!"); ${pidName}=$!`
    : `${prefix}(${command}) 2>&1 | tee -a ${q(sourceErr)} & pids+=("$!"); ${pidName}=$!`;
}

function buildPairedRuntimeLaunchLines({ originalFirstRuntime, stereoDelayMs, fallbackRuntimeLaunch, originalRuntimeLaunch }) {
  const stereoDelaySec = (stereoDelayMs / 1000).toFixed(3);
  return originalFirstRuntime
    ? [
      originalRuntimeLaunch,
      ...(stereoDelayMs > 0 ? [`sleep ${stereoDelaySec}`] : []),
      fallbackRuntimeLaunch,
    ]
    : [fallbackRuntimeLaunch, originalRuntimeLaunch];
}

function buildPairedApplyShellScript({
  singleRuntime,
  shellProfile,
  fallbackPlan,
  originalPlan,
  cleanupPair,
  pairFifos,
  pipeSizerCommands,
  directMuxEnabled,
  directMuxCommand,
  singleRuntimeGpuPlan,
  dualDecode,
  decodeRelayEnabled,
  fallbackDecodeRelayCommand,
  originalDecodeRelayCommand,
  pairedRuntimeLaunchLines,
}) {
  const pairShellProfilePreamble = buildPairShellProfilePreamble({ enabled: shellProfile, fallbackPlan, originalPlan });
  return singleRuntime
    ? buildSingleRuntimePairedApplyShellScript({
      shellProfile,
      fallbackPlan,
      originalPlan,
      cleanupPair,
      pairFifos,
      pipeSizerCommands,
      directMuxEnabled,
      directMuxCommand,
      singleRuntimeGpuPlan,
      dualDecode,
      pairShellProfilePreamble,
    })
    : buildDualRuntimePairedApplyShellScript({
      shellProfile,
      fallbackPlan,
      originalPlan,
      cleanupPair,
      pairFifos,
      pipeSizerCommands,
      directMuxEnabled,
      directMuxCommand,
      dualDecode,
      decodeRelayEnabled,
      fallbackDecodeRelayCommand,
      originalDecodeRelayCommand,
      pairedRuntimeLaunchLines,
      pairShellProfilePreamble,
    });
}

module.exports = {
  buildPairedApplyShellScript,
  buildPairedRuntimeLaunchLines,
  buildRuntimeLaunchCommand,
};
