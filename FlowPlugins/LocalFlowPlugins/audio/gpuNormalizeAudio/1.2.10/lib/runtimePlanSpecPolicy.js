"use strict";

const {
  envFlag,
} = require("./common");
const {
  createOriginalRuntimeEnvArgs,
  sourcePortRuntimeArgs,
} = require("./runtimePlanArgs");

function createRuntimePlanSpecPolicy({
  decodeAudioArgs,
  ingressSampleRateFor,
  processingSampleRateFor,
  runtimeCuda,
  usesStereoFallbackSourcePath,
}) {
  const originalRuntimeEnvArgs = createOriginalRuntimeEnvArgs();
  const firstPassCpuDecodeArgs = envFlag("LOUDNORM_GPU_FIRST_PASS_CPU_DECODE_ARGS", false);
  const firstPassNullOutputWrite = envFlag("LOUDNORM_GPU_FIRST_PASS_NULL_OUTPUT_WRITE", true);

  const planEnvPrefix = (plan) => {
    if (plan.stereoFallback) return [];
    return originalRuntimeEnvArgs.length > 0 ? ["env", ...originalRuntimeEnvArgs] : [];
  };

  const firstPassDecodeAudioArgs = (plan) => {
    if (firstPassCpuDecodeArgs && !plan.stereoFallback) return [];
    return decodeAudioArgs(plan);
  };

  const ratePlanFor = (plan, values) => {
    const processingRate = processingSampleRateFor(plan, values);
    let ingressRate = 0;
    if (ingressSampleRateFor) {
      const candidateIngressRate = ingressSampleRateFor(plan, values);
      ingressRate = candidateIngressRate > 0 && candidateIngressRate !== processingRate ? candidateIngressRate : 0;
    }
    return {
      ingressRate,
      processingRate,
      stereoFallbackSourceExact: usesStereoFallbackSourcePath(plan),
    };
  };

  const sourcePortArgsFor = ({ ratePlan, streamingIo = false, parallelFinalApply = false, expectedSeconds = null, useIngress = true }) => sourcePortRuntimeArgs({
    runtimeCuda,
    streamingIo,
    parallelFinalApply,
    expectedSeconds,
    ingressRate: useIngress ? ratePlan.ingressRate : 0,
  });

  return {
    firstPassDecodeAudioArgs,
    firstPassNullOutputWrite,
    planEnvPrefix,
    ratePlanFor,
    sourcePortArgsFor,
  };
}

module.exports = {
  createRuntimePlanSpecPolicy,
};
