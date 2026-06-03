"use strict";

function describePlanCapabilityBlockers({ splitStats, pairedApply }) {
  return [
    splitStats ? "split_stats" : "",
    pairedApply ? "paired_apply" : "",
  ].filter(Boolean);
}

function createStreamPlanCapabilities({
  processingPlans,
  canSplitStatsPlan,
  pairedFallbackApplyPartner,
}) {
  const planCapabilities = processingPlans.map((plan) => {
    const splitStats = typeof canSplitStatsPlan === "function" && canSplitStatsPlan(plan);
    const pairedApply = typeof pairedFallbackApplyPartner === "function" && !!pairedFallbackApplyPartner(plan);
    const parallelBlockers = describePlanCapabilityBlockers({ splitStats, pairedApply });
    return {
      parallelBlockers,
      pairedApply,
      plan,
      splitStats,
      supportsParallelStream: parallelBlockers.length === 0,
    };
  });
  const blockedParallelPlans = planCapabilities.filter((capability) => !capability.supportsParallelStream);
  return {
    blockedParallelPlans,
    planCapabilities,
    supportsParallelStream: blockedParallelPlans.length === 0,
  };
}

module.exports = {
  createStreamPlanCapabilities,
};
