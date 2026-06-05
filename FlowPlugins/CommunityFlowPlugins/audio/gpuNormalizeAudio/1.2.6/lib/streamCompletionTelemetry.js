"use strict";

const {
  logProfileStage,
  q,
} = require("./common");

async function finishCompletedStream({
  args,
  plan,
  planLabel,
  describePlan,
  streamStartedAt,
  cleanupFiles,
  runChecked,
}) {
  const cleanupRaw = `rm -f ${cleanupFiles.map(q).join(" ")}`;
  const cleanupStreamRes = await runChecked(cleanupRaw, { label: `cleanup ${planLabel}` });
  logProfileStage(args, { scope: "plugin", name: "cleanup_stream", stream: plan.idx, source_stream: plan.sourceIdx, wall_sec: cleanupStreamRes.wallSec });
  args.jobLog(`GPU Normalize Audio result: ${describePlan(plan)} completed.`);
  logProfileStage(args, { scope: "plugin", name: "per_stream_total", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: (Date.now() - streamStartedAt) / 1000 });
  return cleanupStreamRes;
}

async function finishCompletedPairedApply({
  args,
  fallbackPlan,
  originalPlan,
  fallbackLabel,
  originalLabel,
  pairStartedAt,
  cleanupFiles,
  markCompleted,
  runChecked,
}) {
  const cleanupRaw = `rm -f ${cleanupFiles.map(q).join(" ")}`;
  const cleanupStreamRes = await runChecked(cleanupRaw, { label: `cleanup paired apply ${fallbackLabel} + ${originalLabel}` });
  logProfileStage(args, { scope: "plugin", name: "cleanup_stream", stream: fallbackPlan.idx, source_stream: fallbackPlan.sourceIdx, wall_sec: cleanupStreamRes.wallSec });
  logProfileStage(args, { scope: "plugin", name: "cleanup_stream", stream: originalPlan.idx, source_stream: originalPlan.sourceIdx, wall_sec: cleanupStreamRes.wallSec });
  markCompleted();
  args.jobLog(`GPU Normalize Audio result: paired apply ${fallbackLabel} + ${originalLabel} completed.`);
  logProfileStage(args, { scope: "plugin", name: "per_stream_total", stream: fallbackPlan.idx, source_stream: fallbackPlan.sourceIdx, channels: fallbackPlan.channels, wall_sec: (Date.now() - pairStartedAt) / 1000 });
  logProfileStage(args, { scope: "plugin", name: "per_stream_total", stream: originalPlan.idx, source_stream: originalPlan.sourceIdx, channels: originalPlan.channels, wall_sec: (Date.now() - pairStartedAt) / 1000 });
  return cleanupStreamRes;
}

module.exports = {
  finishCompletedPairedApply,
  finishCompletedStream,
};
