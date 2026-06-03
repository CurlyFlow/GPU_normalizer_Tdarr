"use strict";

const path = require("path");

const {
  q,
} = require("./common");

const DEFAULT_RELAY_HELPER = path.join(__dirname, "..", "runtime", "bin", "paired_apply_relay.py");

function relayHelperPath(helperPath) {
  return helperPath || DEFAULT_RELAY_HELPER;
}

function buildDirectMuxRelayCommand({ plan, pythonPath, helperPath = "", spliceRelay, outputPipeMiB = 0 }) {
  const pipeBytes = Math.max(0, Number(outputPipeMiB) || 0) * 1024 * 1024;
  if (spliceRelay) return [String(pythonPath), relayHelperPath(helperPath), "splice", plan.fifoOutput, String(4 * 1024 * 1024), String(pipeBytes)];
  if (pipeBytes > 0) return [String(pythonPath), relayHelperPath(helperPath), "fifo-write", String(pipeBytes), plan.fifoOutput, String(1024 * 1024)];
  return ["sh", "-lc", `cat > ${q(plan.fifoOutput)}`];
}

function buildOrchestratorFifoFdCommand(key) {
  return ["__loudnorm_open_fd_write__", `__loudnorm_fifo_fd_${key}__`];
}

function buildDecodeRelayCommands({ enabled, pythonPath, helperPath = "", relayMiB, fallbackDecodeInput, originalDecodeInput, fallbackPlan, originalPlan }) {
  if (!enabled) return { fallbackDecodeRelayCommand: "", originalDecodeRelayCommand: "" };
  const bytes = String(relayMiB * 1024 * 1024);
  const helper = relayHelperPath(helperPath);
  return {
    fallbackDecodeRelayCommand: `${q(pythonPath)} ${q(helper)} decode ${bytes} ${q(fallbackDecodeInput)} ${q(fallbackPlan.fifoInput)}`,
    originalDecodeRelayCommand: `${q(pythonPath)} ${q(helper)} decode ${bytes} ${q(originalDecodeInput)} ${q(originalPlan.fifoInput)}`,
  };
}

function buildPipeSizerCommands({ pythonPath, helperPath = "", pipeMiB, fallbackPlan, originalPlan }) {
  const pipeSizerCommands = [];
  if (pipeMiB > 0) {
    pipeSizerCommands.push(`${q(pythonPath)} ${q(relayHelperPath(helperPath))} pipe-sizer ${String(pipeMiB * 1024 * 1024)} ${[fallbackPlan.fifoInput, originalPlan.fifoInput].map(q).join(" ")}`);
  }
  return pipeSizerCommands;
}

module.exports = {
  buildDecodeRelayCommands,
  buildDirectMuxRelayCommand,
  buildOrchestratorFifoFdCommand,
  buildPipeSizerCommands,
};
