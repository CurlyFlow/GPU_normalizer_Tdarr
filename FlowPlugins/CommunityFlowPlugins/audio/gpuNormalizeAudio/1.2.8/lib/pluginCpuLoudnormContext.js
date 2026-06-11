"use strict";

const {
  createCpuLoudnormCoordinator,
} = require("./cpuLoudnorm");
const {
  cachedCpuLoudnorm,
} = require("./pluginBootstrap");

function createPairedCpuLoudnormPartner({
  args,
  pairCpuLoudnormMeasure,
  useGpuSourcePort,
  audioPlans,
  needsInlineStereoDownmix,
}) {
  return (plan) => {
    if (!pairCpuLoudnormMeasure || !useGpuSourcePort || args.platform === "win32") return null;
    if (plan.stereoFallback && needsInlineStereoDownmix(plan)) {
      return audioPlans.find((candidate) => !candidate.stereoFallback && candidate.sourceIdx === plan.sourceIdx) || null;
    }
    return audioPlans.find((candidate) => candidate.stereoFallback && candidate.sourceIdx === plan.sourceIdx && needsInlineStereoDownmix(candidate)) || null;
  };
}

function createPluginCpuLoudnormContext({
  args,
  debugLogging,
  useGpuSourcePort,
  gpuFirstPassMeasure,
  gpuFirstPassAudit,
  pairCpuLoudnormMeasure,
  audioPlans,
  needsInlineStereoDownmix,
  runChecked,
  wrapRuntimeProfile,
  buildGpuFirstPassInputMeasure,
  buildGpuFirstPassMeasure,
  buildGpuFirstPassMixedSharedStats,
  buildGpuFirstPassMixedSharedDecode,
  buildGpuFirstPassOutputApplyFromStats,
  buildCpuLoudnormMeasure,
  buildPairedCpuLoudnormMeasure,
  processingSampleRateFor,
  statsCachePathFor,
  trackStatsCachePath,
  sourceChannelsFor,
  planLabelFor,
  loudnessSummary,
  processingPlans,
  cpuMeasurementAvailability,
}) {
  const pairedCpuLoudnormPartner = createPairedCpuLoudnormPartner({
    args,
    pairCpuLoudnormMeasure,
    useGpuSourcePort,
    audioPlans,
    needsInlineStereoDownmix,
  });

  return createCpuLoudnormCoordinator({
    args,
    debugLogging,
    useGpuSourcePort,
    gpuFirstPassMeasure,
    gpuFirstPassAudit,
    runChecked,
    wrapRuntimeProfile,
    buildGpuFirstPassInputMeasure,
    buildGpuFirstPassMeasure,
    buildGpuFirstPassMixedSharedStats,
    buildGpuFirstPassMixedSharedDecode,
    buildGpuFirstPassOutputApplyFromStats,
    buildCpuLoudnormMeasure,
    buildPairedCpuLoudnormMeasure,
    processingSampleRateFor,
    statsCachePathFor,
    trackStatsCachePath,
    sourceChannelsFor,
    pairedCpuLoudnormPartner,
    planLabelFor,
    loudnessSummary,
    cachedCpuLoudnormForPlan: (plan) => cachedCpuLoudnorm(args, plan.sourceIdx, plan.channels, sourceChannelsFor(plan) === plan.channels),
    cpuMeasurementAvailability,
    processingPlans,
  });
}

module.exports = {
  createPairedCpuLoudnormPartner,
  createPluginCpuLoudnormContext,
};
