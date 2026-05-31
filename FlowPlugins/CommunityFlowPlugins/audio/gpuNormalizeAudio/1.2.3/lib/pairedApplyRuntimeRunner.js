"use strict";

const {
  gpuProgressFraction,
  logProfileStage,
} = require("./common");

async function runPairedApplyRuntime({
  args,
  debugLogging,
  pairStereoFallbackApplyShellProfile,
  fallbackPlan,
  originalPlan,
  fallbackLabel,
  originalLabel,
  progressBase,
  script,
  runShell,
  updateProgress,
}) {
  const pairRes = await runShell(script, {
    args,
    label: `GPU paired streaming apply ${fallbackLabel} + ${originalLabel}`,
    allowedCodes: [0, 42],
    capturePath: "",
    logOnSuccess: debugLogging,
    parseLine: (line) => {
      if (pairStereoFallbackApplyShellProfile && args.logFullCliOutput !== true && line.includes("profile_stage ") && line.includes("paired_apply_shell")) args.jobLog(line);
      const fraction = gpuProgressFraction(line);
      if (fraction !== null) updateProgress(progressBase + (fallbackPlan.work + originalPlan.work) * 0.18 + (fallbackPlan.work + originalPlan.work) * 0.62 * fraction);
    },
  });
  logProfileStage(args, { scope: "plugin", name: "gpu_source_port_streaming_paired_apply", stream: fallbackPlan.idx, source_stream: fallbackPlan.sourceIdx, channels: fallbackPlan.channels, wall_sec: pairRes.wallSec });
  logProfileStage(args, { scope: "plugin", name: "gpu_source_port_streaming_paired_apply", stream: originalPlan.idx, source_stream: originalPlan.sourceIdx, channels: originalPlan.channels, wall_sec: pairRes.wallSec });
  if (pairRes.code === 42) return { copyOriginalReason: `GPU normalize gain gate exceeded during paired apply ${fallbackLabel} + ${originalLabel}; copying original package`, pairRes };
  if (pairRes.code !== 0) throw new Error(`GPU paired streaming apply failed on ${fallbackLabel} + ${originalLabel}`);
  return { copyOriginalReason: "", pairRes };
}

module.exports = {
  runPairedApplyRuntime,
};
