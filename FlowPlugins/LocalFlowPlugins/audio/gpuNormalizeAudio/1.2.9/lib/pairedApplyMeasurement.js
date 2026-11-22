"use strict";

const {
  ffmpegProgressFraction,
} = require("./common");
const {
  logCpuLoudnormMeasurement,
} = require("./cpuLoudnormTelemetry");

async function measurePairedApplyLoudnorm({
  args,
  debugLogging,
  plan,
  planLabel,
  measureSpan,
  progressBase,
  durationSeconds,
  splitStatsTask,
  getCpuLoudnormRecord,
  targetI,
  maxGain,
  updateProgress,
}) {
  const measureRecord = await getCpuLoudnormRecord(plan, (line) => {
    const fraction = ffmpegProgressFraction(line, durationSeconds);
    if (fraction !== null) updateProgress(progressBase + measureSpan * fraction);
  });
  const cpuLoudnormValues = measureRecord.values;
  const { skipNormalization } = logCpuLoudnormMeasurement({ args, debugLogging, plan, planLabel, measureRecord, values: cpuLoudnormValues, targetI, maxGain });
  if (skipNormalization) {
    if (splitStatsTask) await splitStatsTask.promise;
    return { skipReason: `gain limit exceeded on ${planLabel}`, cpuLoudnormValues };
  }
  return { skipReason: "", cpuLoudnormValues };
}

module.exports = {
  measurePairedApplyLoudnorm,
};
