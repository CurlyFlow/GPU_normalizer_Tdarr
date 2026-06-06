"use strict";

const {
  envFlag,
  intNum,
} = require("./common");

function createPluginRuntimeFeatureConfig({
  args,
  durationSeconds,
  useGpuSourcePort,
  useStreamingSourcePort,
}) {
  const pairCpuLoudnormMeasure = envFlag("LOUDNORM_GPU_PAIR_CPU_LOUDNORM_MEASURE", false);
  const gpuFirstPassMinSeconds = Math.max(0, Math.min(86400, intNum(process.env.LOUDNORM_GPU_FIRST_PASS_MIN_SECONDS, 120)));
  const gpuFirstPassDefault = Number(durationSeconds) >= gpuFirstPassMinSeconds;
  const gpuFirstPassMeasure = useGpuSourcePort && useStreamingSourcePort && args.platform !== "win32" && envFlag("LOUDNORM_GPU_FIRST_PASS_MEASURE", gpuFirstPassDefault);
  const gpuFirstPassAudit = useGpuSourcePort && useStreamingSourcePort && args.platform !== "win32" && !gpuFirstPassMeasure && envFlag("LOUDNORM_GPU_FIRST_PASS_AUDIT");
  const cpuLoudnormNice = args.platform !== "win32" ? Math.max(0, Math.min(19, intNum(process.env.LOUDNORM_GPU_CPU_LOUDNORM_NICE, 0))) : 0;

  return {
    cpuLoudnormNice,
    gpuFirstPassAudit,
    gpuFirstPassMeasure,
    gpuFirstPassMinSeconds,
    pairCpuLoudnormMeasure,
  };
}

module.exports = {
  createPluginRuntimeFeatureConfig,
};
