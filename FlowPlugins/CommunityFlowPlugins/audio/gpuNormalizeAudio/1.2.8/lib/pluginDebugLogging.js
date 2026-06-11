"use strict";

function logPluginDebugSummary({
  args,
  debugLogging,
  useGpuSourcePort,
  workerType,
  requireGpuWorker,
  logDebugPlanSummary,
  processingPlans,
  audioPlans,
  planLabelFor,
  stereoFallbackSourceExact,
  useStreamingSourcePort,
}) {
  if (!debugLogging) return;
  args.jobLog(useGpuSourcePort
    ? "Running GPU normalize: FFmpeg decode -> CUDA loudness/gain plan+apply -> FFmpeg encode/mux"
    : "Running GPU normalize: FFmpeg decode -> source-core exact gains -> CUDA apply -> FFmpeg encode/mux");
  args.jobLog(`GPU normalize Tdarr worker: worker_type=${workerType || "unknown"} require_gpu_worker=${requireGpuWorker ? "true" : "false"}`);
  logDebugPlanSummary();
  if (processingPlans !== audioPlans) args.jobLog(`GPU normalize processing order: ${processingPlans.map(planLabelFor).join(" -> ")}`);
  if (stereoFallbackSourceExact) args.jobLog("GPU normalize stereo fallback source-exact path enabled");
  for (const plan of audioPlans) {
    args.jobLog(`GPU normalize ${plan.sourceIdx}${plan.stereoFallback ? " stereo fallback" : ""}: estimated_raw_input_mib=${(plan.estimatedRawInputBytes / (1024 * 1024)).toFixed(1)} estimated_raw_output_mib=${(plan.estimatedRawOutputBytes / (1024 * 1024)).toFixed(1)} streaming_io=${useStreamingSourcePort ? "true" : "false"}`);
  }
}

module.exports = {
  logPluginDebugSummary,
};
