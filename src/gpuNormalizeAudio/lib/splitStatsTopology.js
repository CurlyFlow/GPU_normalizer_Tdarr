"use strict";

const PAIRED_SPLIT_STATS_TOPOLOGY = Object.freeze({
  BUFFERED_DECODE: "bufferedDecode",
  DUAL_RUNTIME: "dualRuntime",
  RAW_TEE_CPU: "rawTeeCpu",
  SINGLE_PIPE: "singlePipe",
  SINGLE_RUNTIME: "singleRuntime",
  STDOUT_PRIMARY: "stdoutPrimary",
});

function pairedSplitStatsTopologyKind(topology) {
  if (topology.rawTeeCpuMeasure) return PAIRED_SPLIT_STATS_TOPOLOGY.RAW_TEE_CPU;
  if (topology.bufferedDecode) return PAIRED_SPLIT_STATS_TOPOLOGY.BUFFERED_DECODE;
  if (topology.singlePipe) return PAIRED_SPLIT_STATS_TOPOLOGY.SINGLE_PIPE;
  if (topology.stdoutPrimary) return PAIRED_SPLIT_STATS_TOPOLOGY.STDOUT_PRIMARY;
  if (topology.singleRuntime) return PAIRED_SPLIT_STATS_TOPOLOGY.SINGLE_RUNTIME;
  return PAIRED_SPLIT_STATS_TOPOLOGY.DUAL_RUNTIME;
}

function validatePairedSplitStatsTopology(topology) {
  if (topology.singlePipe && topology.stdoutPrimary) throw new Error("paired split stats plan cannot use single_pipe and stdout_primary together");
  if (topology.rawTeeCpuMeasure && topology.fusePairedCpuMeasure) throw new Error("paired split stats raw-tee CPU mode cannot also fuse CPU loudnorm in the decode graph");
  if (topology.rawTeeCpuMeasure && (topology.bufferedDecode || topology.singlePipe || topology.singleRuntime || topology.stdoutPrimary)) throw new Error("paired split stats raw-tee CPU mode requires independent FIFO topology");
  if (topology.bufferedDecode && (topology.singlePipe || topology.singleRuntime || topology.stdoutPrimary)) throw new Error("paired split stats buffered decode requires independent runtime FIFO topology");
  if (!topology.singleRuntime && (topology.singlePipe || topology.stereoPrimary)) throw new Error("paired split stats plan single-runtime topology flags require single_runtime");
  if (topology.fusePairedCpuMeasure && topology.stdoutPrimary) throw new Error("paired split stats plan cannot fuse CPU loudnorm with stdout_primary topology");
}

function createPairedSplitStatsTopology(flags) {
  const topology = {
    bufferedDecode: Boolean(flags.bufferedDecode),
    fusePairedCpuMeasure: Boolean(flags.fusePairedCpuMeasure),
    rawTeeCpuMeasure: Boolean(flags.rawTeeCpuMeasure),
    singlePipe: Boolean(flags.singlePipe),
    singleRuntime: Boolean(flags.singleRuntime),
    stereoPrimary: Boolean(flags.stereoPrimary),
    stdoutPrimary: Boolean(flags.stdoutPrimary),
  };
  topology.kind = pairedSplitStatsTopologyKind(topology);
  validatePairedSplitStatsTopology(topology);
  return topology;
}

function pairedSplitStatsTopologyLogSuffix(topology) {
  return [
    topology.singleRuntime ? "single_runtime=true" : "",
    topology.singlePipe ? "single_pipe=true" : "",
    topology.bufferedDecode ? "buffered_decode=true" : "",
    topology.stereoPrimary ? "stereo_primary=true" : "",
    topology.stdoutPrimary ? "stdout_primary=true" : "",
    topology.fusePairedCpuMeasure ? "fused_cpu_loudnorm=true" : "",
    topology.rawTeeCpuMeasure ? "raw_tee_cpu_loudnorm=true" : "",
  ].filter(Boolean).map((flag) => ` ${flag}`).join("");
}

module.exports = {
  PAIRED_SPLIT_STATS_TOPOLOGY,
  createPairedSplitStatsTopology,
  pairedSplitStatsTopologyLogSuffix,
};
