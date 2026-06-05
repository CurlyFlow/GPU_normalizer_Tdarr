"use strict";

const {
  ffmpegProgressFraction,
} = require("./common");
const {
  logCpuLoudnormMeasurement,
} = require("./cpuLoudnormTelemetry");

async function measureStreamPlanLoudnorm({
  args,
  debugLogging,
  plan,
  planLabel,
  completedWork,
  measureSpan,
  durationSeconds,
  splitStatsTask,
  getCpuLoudnormRecord,
  targetI,
  maxGain,
  updateProgress,
}) {
  const measureRecord = await getCpuLoudnormRecord(plan, (line) => {
    const fraction = ffmpegProgressFraction(line, durationSeconds);
    if (fraction !== null) updateProgress(completedWork + measureSpan * fraction);
  });
  const cpuLoudnormValues = measureRecord.values;
  const firstPassStatsCacheInput = measureRecord.statsCache || null;
  const { gainNeeded } = logCpuLoudnormMeasurement({ args, debugLogging, plan, planLabel, measureRecord, values: cpuLoudnormValues, targetI, maxGain });
  updateProgress(completedWork + measureSpan, true);
  if (maxGain > 0 && gainNeeded > maxGain) {
    if (splitStatsTask) await splitStatsTask.promise;
    return {
      copyOriginalReason: `GPU normalize gain gate exceeded on ${planLabel}; copying original package`,
      cpuLoudnormValues,
      firstPassStatsCacheInput,
    };
  }
  return {
    copyOriginalReason: "",
    cpuLoudnormValues,
    firstPassStatsCacheInput,
  };
}

module.exports = {
  measureStreamPlanLoudnorm,
};
