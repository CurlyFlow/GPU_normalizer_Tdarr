"use strict";

const PAIRED_APPLY_EXECUTION = {
  DISABLED: "disabled",
  FIRST_READY: "firstReady",
  PERSISTENT_FIRST_READY: "persistentFirstReady",
  RUNTIME: "runtime",
};

const PAIRED_APPLY_RUNTIME = {
  DUAL_RUNTIME: "dualRuntime",
  SINGLE_RUNTIME: "singleRuntime",
};

const PAIRED_APPLY_DIRECT_MUX = {
  NONE: "none",
  ORIGINAL_ONLY: "directMuxOriginalOnly",
  FULL: "directMuxFull",
};

function validatePairedApplyTopology(config, topology) {
  if (!topology.enabled && topology.executionKind !== PAIRED_APPLY_EXECUTION.DISABLED) {
    throw new Error("paired apply topology enabled mismatch");
  }
  if (topology.runtimeKind === PAIRED_APPLY_RUNTIME.SINGLE_RUNTIME && (config.runtime.firstReady || config.runtime.persistent)) {
    throw new Error("paired apply single runtime cannot also use first-ready runtime scheduling");
  }
  if (config.directMux.originalOnly && !config.directMux.requested) {
    throw new Error("paired apply direct mux original-only requires direct mux");
  }
  if ((config.directMux.orchestratorFifoFd || config.directMux.osPipe) && (!config.directMux.requested || config.runtime.single)) {
    throw new Error("paired apply direct mux fd modes require dual-runtime direct mux");
  }
}

function createPairedApplyTopology(config) {
  const enabled = config.enabled;
  const executionKind = !enabled
    ? PAIRED_APPLY_EXECUTION.DISABLED
    : config.runtime.persistent
      ? PAIRED_APPLY_EXECUTION.PERSISTENT_FIRST_READY
      : config.runtime.firstReady
        ? PAIRED_APPLY_EXECUTION.FIRST_READY
        : PAIRED_APPLY_EXECUTION.RUNTIME;
  const runtimeKind = config.runtime.single
    ? PAIRED_APPLY_RUNTIME.SINGLE_RUNTIME
    : PAIRED_APPLY_RUNTIME.DUAL_RUNTIME;
  const directMuxKind = !config.directMux.requested
    ? PAIRED_APPLY_DIRECT_MUX.NONE
    : config.directMux.originalOnly
      ? PAIRED_APPLY_DIRECT_MUX.ORIGINAL_ONLY
      : PAIRED_APPLY_DIRECT_MUX.FULL;
  const topology = {
    directMuxKind,
    enabled,
    executionKind,
    firstReady: executionKind === PAIRED_APPLY_EXECUTION.FIRST_READY,
    persistentRuntime: executionKind === PAIRED_APPLY_EXECUTION.PERSISTENT_FIRST_READY,
    runtimeKind,
    singleRuntime: runtimeKind === PAIRED_APPLY_RUNTIME.SINGLE_RUNTIME,
    usesRuntimeStage: executionKind === PAIRED_APPLY_EXECUTION.RUNTIME,
  };
  validatePairedApplyTopology(config, topology);
  return topology;
}

function resolvePairedApplyStrategy(config) {
  const topology = createPairedApplyTopology(config);
  return {
    decode: {
      directFifoDecode: config.decode.directFifo,
      filterThreads: config.decode.filterThreads,
      originalFirst: config.decode.originalFirst,
      relayEnabled: config.decode.relayEnabled,
      relayMiB: config.decode.relayMiB,
    },
    directMux: {
      ...config.directMux,
      kind: topology.directMuxKind,
      originalOnly: topology.directMuxKind === PAIRED_APPLY_DIRECT_MUX.ORIGINAL_ONLY,
    },
    nice: config.nice,
    pipes: config.pipes,
    runtime: {
      ...config.runtime,
      firstReady: topology.firstReady,
      kind: topology.runtimeKind,
      persistentRuntime: topology.persistentRuntime,
      single: topology.singleRuntime,
    },
    topology,
  };
}

module.exports = {
  resolvePairedApplyStrategy,
};
