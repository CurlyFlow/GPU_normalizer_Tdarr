"use strict";

const {
  createPairedApplyConfig,
} = require("./pairedApplyConfig");
const {
  runPairedFallbackApplyPlan,
} = require("./pairedApplyExecution");

function createPairedApplyCoordinator(context) {
  const { model, statsContext } = context;
  const { args } = model.core;
  const { useGpuSourcePort } = model.runtimeConfig.runtimePathConfig;
  const { useStreamingSourcePort } = model.runtimeConfig.audioConfig;
  const { audioPlans, usesStereoFallbackSourcePath } = model.planSetup;
  const { canSplitStatsPlan } = statsContext;
  const pairedApplyConfig = createPairedApplyConfig({ args, useGpuSourcePort, useStreamingSourcePort });
  const pairStereoFallbackApply = pairedApplyConfig.enabled;
  let pairedDirectMuxCompleted = false;
  const pairedApplyCompleted = new Set();
  const separateApply = new Set();

  const canPairFallbackAndOriginal = (fallbackPlan, originalPlan) => {
    if (!fallbackPlan || !originalPlan || !fallbackPlan.stereoFallback || originalPlan.stereoFallback) return false;
    if (!usesStereoFallbackSourcePath(fallbackPlan)) return false;
    if (fallbackPlan.sourceIdx !== originalPlan.sourceIdx) return false;
    if (!originalPlan.channelLayout) return false;
    if (!canSplitStatsPlan(fallbackPlan) || !canSplitStatsPlan(originalPlan)) return false;
    if (fallbackPlan.rawInputFormat !== originalPlan.rawInputFormat || fallbackPlan.rawGpuFormat !== originalPlan.rawGpuFormat) return false;
    return true;
  };

  const pairedFallbackApplyPartner = (plan) => {
    if (!pairStereoFallbackApply || !plan.stereoFallback || separateApply.has(plan.idx)) return null;
    const partner = audioPlans.find((candidate) => !candidate.stereoFallback && candidate.sourceIdx === plan.sourceIdx);
    return canPairFallbackAndOriginal(plan, partner) ? partner : null;
  };

  const runPairedFallbackApply = async (fallbackPlan, originalPlan, progressBase, skipNormalization) => {
    const result = await runPairedFallbackApplyPlan({
      context,
      pairedApplyConfig,
      fallbackPlan,
      originalPlan,
      progressBase,
      markDirectMuxCompleted: () => {
        pairedDirectMuxCompleted = true;
      },
      pairedApplyCompleted,
      skipNormalization,
    });
    if (result.separateApply) {
      separateApply.add(fallbackPlan.idx);
      separateApply.add(originalPlan.idx);
    }
    return result;
  };

  return {
    isPairedDirectMuxCompleted: () => pairedDirectMuxCompleted,
    pairStereoFallbackApply,
    pairedApplyCompleted,
    pairedFallbackApplyPartner,
    runPairedFallbackApply,
  };
}

module.exports = {
  createPairedApplyCoordinator,
};
