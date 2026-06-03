"use strict";

function resolvePairedApplyStrategy(config) {
  return {
    decode: {
      directFifoDecode: config.pairStereoFallbackApplyDirectFifoDecode,
      filterThreads: config.pairStereoFallbackApplyDecodeFilterThreads,
      originalFirst: config.pairStereoFallbackApplyOriginalFirstDecode,
      relayEnabled: config.pairStereoFallbackApplyDecodeRelay,
      relayMiB: config.pairStereoFallbackApplyDecodeRelayMiB,
    },
    directMux: {
      requested: config.pairStereoFallbackApplyDirectMux,
      directFifoWrite: config.pairStereoFallbackApplyDirectFifoWrite,
      fallbackFirst: config.pairStereoFallbackApplyDirectMuxFallbackFirst,
      noProgress: config.pairStereoFallbackApplyDirectMuxNoProgress,
      orchestratorFifoFd: config.pairStereoFallbackApplyOrchestratorFifoFd,
      quietLog: config.pairStereoFallbackApplyDirectMuxQuietLog,
      spliceRelay: config.pairStereoFallbackApplySpliceRelay,
      threadQueueSize: config.pairStereoFallbackApplyDirectMuxThreadQueueSize,
    },
    nice: {
      fallback: config.pairStereoFallbackApplyStereoNice,
      original: config.pairStereoFallbackApplyOriginalNice,
    },
    pipes: {
      inputMiB: config.pairStereoFallbackApplyPipeMiB,
      outputMiB: config.pairStereoFallbackApplyOutputPipeMiB,
    },
    runtime: {
      noTee: config.pairStereoFallbackApplyNoTee,
      originalFirst: config.pairStereoFallbackApplyOriginalFirstRuntime,
      shellProfile: config.pairStereoFallbackApplyShellProfile,
      single: config.pairStereoFallbackApplySingleRuntime,
      stereoDelayMs: config.pairStereoFallbackApplyStereoDelayMs,
    },
  };
}

module.exports = {
  resolvePairedApplyStrategy,
};
