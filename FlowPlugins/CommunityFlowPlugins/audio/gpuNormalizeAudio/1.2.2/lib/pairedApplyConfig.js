"use strict";

const {
  envFlag,
  intNum,
} = require("./common");

function createPairedApplyConfig({ args, useGpuSourcePort, useStreamingSourcePort }) {
  const pairStereoFallbackApply = envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY", true) && useGpuSourcePort && useStreamingSourcePort && args.platform !== "win32";
  const pairStereoFallbackApplySingleRuntime = pairStereoFallbackApply && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_SINGLE_RUNTIME");
  const pairStereoFallbackApplyOriginalFirstDecode = pairStereoFallbackApply && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_ORIGINAL_FIRST_DECODE");
  const pairStereoFallbackApplyDirectMux = pairStereoFallbackApply && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DIRECT_MUX", true);
  const pairStereoFallbackApplyNoTee = pairStereoFallbackApply && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_NO_TEE");
  const pairStereoFallbackApplyStereoNice = pairStereoFallbackApply ? Math.max(0, Math.min(19, intNum(process.env.LOUDNORM_GPU_PAIR_FALLBACK_APPLY_STEREO_NICE, 0))) : 0;
  const pairStereoFallbackApplyOriginalNice = pairStereoFallbackApply ? Math.max(0, Math.min(19, intNum(process.env.LOUDNORM_GPU_PAIR_FALLBACK_APPLY_ORIGINAL_NICE, 0))) : 0;
  const pairStereoFallbackApplyOriginalFirstRuntime = pairStereoFallbackApply && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_ORIGINAL_FIRST_RUNTIME");
  const pairStereoFallbackApplyStereoDelayMs = pairStereoFallbackApply ? Math.max(0, Math.min(10000, intNum(process.env.LOUDNORM_GPU_PAIR_FALLBACK_APPLY_STEREO_DELAY_MS, 0))) : 0;
  const pairStereoFallbackApplyPipeMiB = pairStereoFallbackApply ? Math.max(0, Math.min(1024, intNum(process.env.LOUDNORM_GPU_PAIR_FALLBACK_APPLY_PIPE_MIB, 0))) : 0;
  const pairStereoFallbackApplyOutputPipeMiB = pairStereoFallbackApplyDirectMux ? Math.max(0, Math.min(1024, intNum(process.env.LOUDNORM_GPU_PAIR_FALLBACK_APPLY_OUTPUT_PIPE_MIB, 0))) : 0;
  const pairStereoFallbackApplyDecodeRelay = pairStereoFallbackApply && !pairStereoFallbackApplySingleRuntime && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DECODE_RELAY");
  const pairStereoFallbackApplyDecodeRelayMiB = pairStereoFallbackApplyDecodeRelay ? Math.max(1, Math.min(2048, intNum(process.env.LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DECODE_RELAY_MIB, 256))) : 0;
  const pairStereoFallbackApplyDirectFifoDecode = pairStereoFallbackApply && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DIRECT_FIFO_DECODE", true);
  const pairStereoFallbackApplyDirectFifoWrite = pairStereoFallbackApply && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DIRECT_FIFO_WRITE");
  const pairStereoFallbackApplyDirectMuxFallbackFirst = pairStereoFallbackApplyDirectMux && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DIRECT_MUX_FALLBACK_FIRST", true);
  const pairStereoFallbackApplySpliceRelay = pairStereoFallbackApplyDirectMux && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_SPLICE_RELAY");
  const pairStereoFallbackApplyDirectMuxThreadQueueSize = pairStereoFallbackApplyDirectMux ? Math.max(0, Math.min(1048576, intNum(process.env.LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DIRECT_MUX_THREAD_QUEUE_SIZE, 0))) : 0;
  const pairStereoFallbackApplyDirectMuxNoProgress = pairStereoFallbackApplyDirectMux && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DIRECT_MUX_NO_PROGRESS");
  const pairStereoFallbackApplyShellProfile = pairStereoFallbackApply && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_SHELL_PROFILE");
  const pairStereoFallbackApplyDecodeFilterThreads = pairStereoFallbackApply ? Math.max(0, Math.min(16, intNum(process.env.LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DECODE_FILTER_THREADS, 0))) : 0;

  return {
    pairStereoFallbackApply,
    pairStereoFallbackApplyDecodeFilterThreads,
    pairStereoFallbackApplyDecodeRelay,
    pairStereoFallbackApplyDecodeRelayMiB,
    pairStereoFallbackApplyDirectFifoDecode,
    pairStereoFallbackApplyDirectFifoWrite,
    pairStereoFallbackApplyDirectMux,
    pairStereoFallbackApplyDirectMuxFallbackFirst,
    pairStereoFallbackApplyDirectMuxNoProgress,
    pairStereoFallbackApplyDirectMuxThreadQueueSize,
    pairStereoFallbackApplyNoTee,
    pairStereoFallbackApplyOriginalFirstDecode,
    pairStereoFallbackApplyOriginalFirstRuntime,
    pairStereoFallbackApplyOriginalNice,
    pairStereoFallbackApplyOutputPipeMiB,
    pairStereoFallbackApplyPipeMiB,
    pairStereoFallbackApplyShellProfile,
    pairStereoFallbackApplySingleRuntime,
    pairStereoFallbackApplySpliceRelay,
    pairStereoFallbackApplyStereoDelayMs,
    pairStereoFallbackApplyStereoNice,
  };
}

module.exports = {
  createPairedApplyConfig,
};
