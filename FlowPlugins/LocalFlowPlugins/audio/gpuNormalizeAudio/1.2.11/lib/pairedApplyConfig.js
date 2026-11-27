"use strict";

const {
  envFlag,
  intNum,
} = require("./common");

function createPairedApplyConfig({ args, useGpuSourcePort, useStreamingSourcePort }) {
  const enabled = envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY", false) && useGpuSourcePort && useStreamingSourcePort && args.platform !== "win32";
  const singleRuntime = enabled && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_SINGLE_RUNTIME");
  const originalOnly = enabled && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DIRECT_MUX_ORIGINAL_ONLY");
  const encodedFifoOriginal = enabled && String(process.env.LOUDNORM_GPU_PAIR_FALLBACK_APPLY_ENCODED_FIFO_MUX || "").toLowerCase() === "original";
  const directMux = enabled && (envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DIRECT_MUX", false) || originalOnly || encodedFifoOriginal);
  const relayEnabled = enabled && !singleRuntime && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DECODE_RELAY");

  return {
    decode: {
      directFifo: enabled && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DIRECT_FIFO_DECODE", true),
      filterThreads: enabled ? Math.max(0, Math.min(16, intNum(process.env.LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DECODE_FILTER_THREADS, 0))) : 0,
      originalFirst: enabled && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_ORIGINAL_FIRST_DECODE", true),
      relayEnabled,
      relayMiB: relayEnabled ? Math.max(1, Math.min(2048, intNum(process.env.LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DECODE_RELAY_MIB, 256))) : 0,
    },
    directMux: {
      directFifoWrite: enabled && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DIRECT_FIFO_WRITE", true),
      encodedFifoOriginal,
      fallbackFirst: directMux && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DIRECT_MUX_FALLBACK_FIRST", false),
      noProgress: directMux && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DIRECT_MUX_NO_PROGRESS", true),
      originalOnly,
      orchestratorFifoFd: directMux && !singleRuntime && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_ORCHESTRATOR_FIFO_FD"),
      osPipe: directMux && !singleRuntime && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DIRECT_MUX_OS_PIPE"),
      quietLog: directMux && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DIRECT_MUX_QUIET_LOG"),
      requested: directMux,
      spliceRelay: directMux && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_SPLICE_RELAY"),
      threadQueueSize: directMux ? Math.max(0, Math.min(1048576, intNum(process.env.LOUDNORM_GPU_PAIR_FALLBACK_APPLY_DIRECT_MUX_THREAD_QUEUE_SIZE, 0))) : 0,
    },
    enabled,
    nice: {
      fallback: enabled ? Math.max(0, Math.min(19, intNum(process.env.LOUDNORM_GPU_PAIR_FALLBACK_APPLY_STEREO_NICE, 0))) : 0,
      original: enabled ? Math.max(0, Math.min(19, intNum(process.env.LOUDNORM_GPU_PAIR_FALLBACK_APPLY_ORIGINAL_NICE, 0))) : 0,
    },
    pipes: {
      inputMiB: enabled ? Math.max(0, Math.min(1024, intNum(process.env.LOUDNORM_GPU_PAIR_FALLBACK_APPLY_PIPE_MIB, 0))) : 0,
      outputMiB: directMux ? Math.max(0, Math.min(1024, intNum(process.env.LOUDNORM_GPU_PAIR_FALLBACK_APPLY_OUTPUT_PIPE_MIB, 0))) : 0,
    },
    runtime: {
      firstReady: enabled && !singleRuntime && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_FIRST_READY", true),
      noTee: enabled && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_NO_TEE", true),
      originalFirst: enabled && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_ORIGINAL_FIRST_RUNTIME"),
      persistent: enabled && !singleRuntime && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_PERSISTENT_RUNTIME"),
      shellProfile: enabled && envFlag("LOUDNORM_GPU_PAIR_FALLBACK_APPLY_SHELL_PROFILE"),
      single: singleRuntime,
      stereoDelayMs: enabled ? Math.max(0, Math.min(10000, intNum(process.env.LOUDNORM_GPU_PAIR_FALLBACK_APPLY_STEREO_DELAY_MS, 0))) : 0,
    },
  };
}

module.exports = {
  createPairedApplyConfig,
};
