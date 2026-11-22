"use strict";

const {
  finishCompletedPairedApply,
} = require("./streamCompletionTelemetry");

async function finishPairedApplyExecution({
  args,
  directMuxEnabled,
  fallbackLabel,
  fallbackPlan,
  markDirectMuxCompleted,
  originalLabel,
  originalPlan,
  pairedApplyCompleted,
  pairStartedAt,
  cleanupFilesForPlan,
  runChecked,
}) {
  if (directMuxEnabled) markDirectMuxCompleted();
  await finishCompletedPairedApply({
    args,
    fallbackPlan,
    originalPlan,
    fallbackLabel,
    originalLabel,
    pairStartedAt,
    cleanupFiles: [...cleanupFilesForPlan(fallbackPlan), ...cleanupFilesForPlan(originalPlan)].filter((file) => file !== fallbackPlan.normalizedAudio && file !== originalPlan.normalizedAudio),
    markCompleted: () => {
      pairedApplyCompleted.add(fallbackPlan.idx);
      pairedApplyCompleted.add(originalPlan.idx);
    },
    runChecked,
  });
}

module.exports = {
  finishPairedApplyExecution,
};
