"use strict";

const {
  logProfileStage,
  loudnormNumber,
} = require("./common");

function logCpuLoudnormMeasurement({
  args,
  debugLogging,
  plan,
  planLabel,
  measureRecord,
  values,
  targetI,
  maxGain,
}) {
  if (measureRecord.reused || measureRecord.source !== "measured") {
    const measureSource = measureRecord.source === "measured" && measureRecord.reused ? "reused" : measureRecord.source;
    args.jobLog(`GPU Normalize Audio step: using ${measureSource} loudness measurement for ${planLabel}.`);
    if (debugLogging) args.jobLog(`GPU normalize using ${measureSource} CPU loudnorm first pass ${planLabel}: ${JSON.stringify(values)}`);
  }
  const inputI = loudnormNumber(values, "input_i");
  const gainNeeded = targetI - inputI;
  args.jobLog(`GPU Normalize Audio decision: ${planLabel} needs ${gainNeeded.toFixed(2)} LU gain; limit is ${maxGain.toFixed(2)} LU.`);
  const cpuWaitSec = measureRecord.waitSec || 0;
  const cpuOverlapSec = Math.max(0, measureRecord.wallSec - cpuWaitSec);
  logProfileStage(args, { scope: "plugin", name: "cpu_loudnorm_first_pass", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: measureRecord.wallSec, wait_sec: cpuWaitSec, overlap_sec: cpuOverlapSec, queued_sec: measureRecord.queuedSec || 0, source: measureRecord.source || "measured", cached: measureRecord.source === "external_cached" ? 1 : 0, reused: measureRecord.reused ? 1 : 0, prefetched: measureRecord.source === "prefetched" ? 1 : 0, background: measureRecord.background ? 1 : 0 });
  return {
    gainNeeded,
  };
}

module.exports = {
  logCpuLoudnormMeasurement,
};
