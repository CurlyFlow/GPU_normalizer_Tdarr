"use strict";

const {
  q,
} = require("./common");

function pairProfileLines(enabled, ...lines) {
  return enabled ? lines : [];
}

function buildSingleRuntimePairedApplyShellScript({
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
}) {
  return [
    "set -o pipefail",
    ...pairShellProfilePreamble,
    cleanupPair,
    ...pairProfileLines(shellProfile, "mkfifo_start_ns=$(profile_now_ns)"),
    `mkfifo ${pairFifos.map(q).join(" ")}`,
    ...pairProfileLines(shellProfile, "profile_stage_emit paired_apply_shell_mkfifo \"$mkfifo_start_ns\" exit_code=0"),
    "pids=()",
    `cleanup(){ for pid in "\${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; ${cleanupPair}; }`,
    "trap cleanup EXIT",
    ...pipeSizerCommands.map((command) => `(${command}) & pids+=("$!")`),
    ...(directMuxEnabled ? [
      ...pairProfileLines(shellProfile, "direct_mux_start_ns=$(profile_now_ns)"),
      `(${directMuxCommand}) 2>> ${q(fallbackPlan.sourceErr)} & pids+=("$!"); pid_direct_mux=$!`,
    ] : []),
    ...pairProfileLines(shellProfile, "runtime_start_ns=$(profile_now_ns)"),
    `(${singleRuntimeGpuPlan}) 2>&1 | tee -a ${q(fallbackPlan.sourceErr)} ${q(originalPlan.sourceErr)} & pids+=("$!"); pid_runtime=$!`,
    ...pairProfileLines(shellProfile, "dual_decode_start_ns=$(profile_now_ns)"),
    dualDecode,
    "ffmpeg_code=$?",
    ...pairProfileLines(shellProfile, "profile_stage_emit paired_apply_shell_dual_decode \"$dual_decode_start_ns\" exit_code=$ffmpeg_code"),
    `if [ "$ffmpeg_code" -ne 0 ]; then kill "$pid_runtime"${directMuxEnabled ? ' "$pid_direct_mux"' : ''} 2>/dev/null || true; wait "$pid_runtime" 2>/dev/null; ${directMuxEnabled ? 'wait "$pid_direct_mux" 2>/dev/null; ' : ''}exit "$ffmpeg_code"; fi`,
    ...pairProfileLines(shellProfile, "runtime_wait_start_ns=$(profile_now_ns)"),
    "wait \"$pid_runtime\"; runtime_code=$?",
    ...pairProfileLines(shellProfile, "profile_stage_emit paired_apply_shell_runtime \"$runtime_start_ns\" exit_code=$runtime_code", "profile_stage_emit paired_apply_shell_wait_runtime \"$runtime_wait_start_ns\" exit_code=$runtime_code"),
    ...(directMuxEnabled ? [
      ...pairProfileLines(shellProfile, "direct_mux_wait_start_ns=$(profile_now_ns)"),
      "if [ \"$runtime_code\" -ne 0 ]; then kill \"$pid_direct_mux\" 2>/dev/null || true; wait \"$pid_direct_mux\" 2>/dev/null; mux_code=0; else wait \"$pid_direct_mux\"; mux_code=$?; fi",
      ...pairProfileLines(shellProfile, "profile_stage_emit paired_apply_shell_direct_mux \"$direct_mux_start_ns\" exit_code=${mux_code:-0}", "profile_stage_emit paired_apply_shell_wait_direct_mux \"$direct_mux_wait_start_ns\" exit_code=${mux_code:-0}"),
    ] : []),
    ...pairProfileLines(shellProfile, "profile_stage_emit paired_apply_shell_total \"$pair_shell_start_ns\" exit_code=${mux_code:-$runtime_code}"),
    "trap - EXIT",
    cleanupPair,
    "if [ \"$runtime_code\" -ne 0 ]; then exit \"$runtime_code\"; fi",
    ...(directMuxEnabled ? ["if [ \"$mux_code\" -ne 0 ]; then exit \"$mux_code\"; fi"] : []),
  ].join("\n");
}

function buildDualRuntimePairedApplyShellScript({
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
}) {
  return [
    "set -o pipefail",
    ...pairShellProfilePreamble,
    cleanupPair,
    ...pairProfileLines(shellProfile, "mkfifo_start_ns=$(profile_now_ns)"),
    `mkfifo ${pairFifos.map(q).join(" ")}`,
    ...pairProfileLines(shellProfile, "profile_stage_emit paired_apply_shell_mkfifo \"$mkfifo_start_ns\" exit_code=0"),
    "pids=()",
    `cleanup(){ for pid in "\${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; ${cleanupPair}; }`,
    "trap cleanup EXIT",
    ...pipeSizerCommands.map((command) => `(${command}) & pids+=("$!")`),
    ...(directMuxEnabled ? [
      ...pairProfileLines(shellProfile, "direct_mux_start_ns=$(profile_now_ns)"),
      `(${directMuxCommand}) 2>> ${q(fallbackPlan.sourceErr)} & pids+=("$!"); pid_direct_mux=$!`,
    ] : []),
    ...(decodeRelayEnabled ? [
      `(${fallbackDecodeRelayCommand}) 2>> ${q(fallbackPlan.sourceErr)} & pids+=("$!"); pid_fallback_relay=$!`,
      `(${originalDecodeRelayCommand}) 2>> ${q(originalPlan.sourceErr)} & pids+=("$!"); pid_original_relay=$!`,
    ] : []),
    ...pairedRuntimeLaunchLines,
    ...pairProfileLines(shellProfile, "dual_decode_start_ns=$(profile_now_ns)"),
    dualDecode,
    "ffmpeg_code=$?",
    ...pairProfileLines(shellProfile, "profile_stage_emit paired_apply_shell_dual_decode \"$dual_decode_start_ns\" exit_code=$ffmpeg_code"),
    `if [ "$ffmpeg_code" -ne 0 ]; then kill "$pid_fallback" "$pid_original"${decodeRelayEnabled ? ' "$pid_fallback_relay" "$pid_original_relay"' : ''} 2>/dev/null || true; wait "$pid_fallback" 2>/dev/null; wait "$pid_original" 2>/dev/null; exit "$ffmpeg_code"; fi`,
    ...pairProfileLines(shellProfile, "fallback_wait_start_ns=$(profile_now_ns)"),
    "wait \"$pid_fallback\"; fallback_code=$?",
    ...pairProfileLines(shellProfile, "profile_stage_emit paired_apply_shell_runtime_fallback \"$fallback_runtime_start_ns\" exit_code=$fallback_code", "profile_stage_emit paired_apply_shell_wait_fallback \"$fallback_wait_start_ns\" exit_code=$fallback_code"),
    ...pairProfileLines(shellProfile, "original_wait_start_ns=$(profile_now_ns)"),
    "wait \"$pid_original\"; original_code=$?",
    ...pairProfileLines(shellProfile, "profile_stage_emit paired_apply_shell_runtime_original \"$original_runtime_start_ns\" exit_code=$original_code", "profile_stage_emit paired_apply_shell_wait_original \"$original_wait_start_ns\" exit_code=$original_code"),
    ...(decodeRelayEnabled ? [
      "wait \"$pid_fallback_relay\"; fallback_relay_code=$?",
      "wait \"$pid_original_relay\"; original_relay_code=$?",
    ] : []),
    ...(directMuxEnabled ? [
      ...pairProfileLines(shellProfile, "direct_mux_wait_start_ns=$(profile_now_ns)"),
      "if [ \"$fallback_code\" -ne 0 ] || [ \"$original_code\" -ne 0 ]; then kill \"$pid_direct_mux\" 2>/dev/null || true; wait \"$pid_direct_mux\" 2>/dev/null; fi",
      "if [ \"$fallback_code\" -eq 0 ] && [ \"$original_code\" -eq 0 ]; then wait \"$pid_direct_mux\"; mux_code=$?; else mux_code=0; fi",
      ...pairProfileLines(shellProfile, "profile_stage_emit paired_apply_shell_direct_mux \"$direct_mux_start_ns\" exit_code=${mux_code:-0}", "profile_stage_emit paired_apply_shell_wait_direct_mux \"$direct_mux_wait_start_ns\" exit_code=${mux_code:-0}"),
    ] : []),
    ...pairProfileLines(shellProfile, "profile_stage_emit paired_apply_shell_total \"$pair_shell_start_ns\" exit_code=${mux_code:-0}"),
    "trap - EXIT",
    cleanupPair,
    "if [ \"$fallback_code\" -ne 0 ]; then exit \"$fallback_code\"; fi",
    "if [ \"$original_code\" -ne 0 ]; then exit \"$original_code\"; fi",
    ...(decodeRelayEnabled ? [
      "if [ \"$fallback_relay_code\" -ne 0 ]; then exit \"$fallback_relay_code\"; fi",
      "if [ \"$original_relay_code\" -ne 0 ]; then exit \"$original_relay_code\"; fi",
    ] : []),
    ...(directMuxEnabled ? ["if [ \"$mux_code\" -ne 0 ]; then exit \"$mux_code\"; fi"] : []),
  ].join("\n");
}

module.exports = {
  buildDualRuntimePairedApplyShellScript,
  buildSingleRuntimePairedApplyShellScript,
};
