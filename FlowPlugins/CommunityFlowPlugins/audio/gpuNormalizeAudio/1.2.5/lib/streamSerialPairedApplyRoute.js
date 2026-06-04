"use strict";

async function runSerialPairedApplyRoute({
  plan,
  completedWork,
  measureSpan,
  decodeSpan,
  normalizeSpan,
  pairedApplyCompleted,
  pairedFallbackApplyPartner,
  runPairedFallbackApply,
  copyOriginalPackage,
  updateProgress,
}) {
  const pairedApplyPartner = pairedFallbackApplyPartner(plan);
  if (!pairedApplyPartner || pairedApplyCompleted.has(pairedApplyPartner.idx)) return null;

  const pairRes = await runPairedFallbackApply(plan, pairedApplyPartner, completedWork);
  if (pairRes.copyOriginalReason) {
    return {
      outputResult: await copyOriginalPackage(
        pairRes.copyOriginalReason,
        completedWork + measureSpan + decodeSpan + normalizeSpan,
      ),
    };
  }
  const nextCompletedWork = completedWork + plan.work + pairedApplyPartner.work;
  updateProgress(nextCompletedWork, true);
  return { completedWork: nextCompletedWork };
}

module.exports = {
  runSerialPairedApplyRoute,
};
