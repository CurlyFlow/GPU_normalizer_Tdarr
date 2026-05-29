"use strict";

const {
  logCpuLoudnormMeasurement,
} = require("./cpuLoudnormTelemetry");

async function measureParallelStreams({
  args,
  debugLogging,
  processingPlans,
  planLabelFor,
  describePlan,
  getCpuLoudnormRecord,
  targetI,
  maxGain,
  reportPlanProgress,
}) {
  const measuredPlans = new Map();
  const measureResults = await Promise.all(processingPlans.map(async (plan) => {
    const streamStartedAt = Date.now();
    const planLabel = planLabelFor(plan);
    args.jobLog(`GPU Normalize Audio step: ${describePlan(plan)}.`);
    const measureSpan = plan.work * 0.18;
    const measureRecord = await getCpuLoudnormRecord(plan);
    const cpuLoudnormValues = measureRecord.values;
    const { gainNeeded } = logCpuLoudnormMeasurement({ args, debugLogging, plan, planLabel, measureRecord, values: cpuLoudnormValues, targetI, maxGain });
    reportPlanProgress(plan, measureSpan, true);
    measuredPlans.set(plan.idx, { cpuLoudnormValues, streamStartedAt });
    if (maxGain > 0 && gainNeeded > maxGain) {
      return { copyOriginalReason: `GPU normalize gain gate exceeded on ${planLabel}; copying original package` };
    }
    return { copyOriginalReason: "" };
  }));

  return {
    gainGate: measureResults.find((result) => result && result.copyOriginalReason),
    measuredPlans,
  };
}

module.exports = {
  measureParallelStreams,
};
