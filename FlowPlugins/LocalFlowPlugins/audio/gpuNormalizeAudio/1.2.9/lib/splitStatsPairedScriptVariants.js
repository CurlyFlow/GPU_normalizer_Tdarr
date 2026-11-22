"use strict";

const {
  q,
} = require("./common");
const {
  PAIRED_SPLIT_STATS_TOPOLOGY,
} = require("./splitStatsTopology");

function qList(paths) {
  return paths.map((entry) => q(entry)).join(" ");
}

function pairedStatsErrorPaths({ partner, partnerStatsErr, plan, statsErr, topology }) {
  return [
    statsErr,
    partnerStatsErr,
    topology.fusePairedCpuMeasure ? plan.measureErr : null,
    topology.rawTeeCpuMeasure ? plan.measureErr : null,
    topology.rawTeeCpuMeasure ? partner.measureErr : null,
  ].filter(Boolean);
}

function teeCommand(command, paths) {
  return `(${command}) 2>&1 | tee -a ${qList(paths)}`;
}

function pidRef(pidVar) {
  return `"$${pidVar}"`;
}

function pidRefs(pidVars) {
  return pidVars.map((pidVar) => pidRef(pidVar)).join(" ");
}

function renderBackgroundProcess(processSpec) {
  const command = processSpec.teePaths
    ? teeCommand(processSpec.command, processSpec.teePaths)
    : processSpec.command;
  return `${command} & ${processSpec.pidVar}=$!; pids="$pids $${processSpec.pidVar}"`;
}

function renderWait({ codeVar, pidVar }) {
  return `wait ${pidRef(pidVar)}; ${codeVar}=$?`;
}

function renderExitOnFailure(codeVar) {
  return `if [ "$${codeVar}" -ne 0 ]; then exit "$${codeVar}"; fi`;
}

function renderForegroundFailureCheck(codeVar, pidVars) {
  const waits = pidVars.map((pidVar) => `wait ${pidRef(pidVar)} 2>/dev/null`).join("; ");
  return `if [ "$${codeVar}" -ne 0 ]; then kill ${pidRefs(pidVars)} 2>/dev/null || true; ${waits}; exit "$${codeVar}"; fi`;
}

function renderCleanup({ cleanupFifos, killBackgrounds }) {
  const kill = killBackgrounds
    ? `for p in $pids; do kill "$p" 2>/dev/null || true; done; `
    : "";
  return `cleanup(){ ${kill}rm -f ${qList(cleanupFifos)}; }`;
}

function renderProcessGraph(graph) {
  const lines = [];
  if (graph.pipefail) lines.push("set -o pipefail");
  lines.push(`rm -f ${qList(graph.removePaths)}`);
  if (graph.fifos.length > 0) lines.push(`mkfifo ${qList(graph.fifos)}`);
  if (graph.backgrounds.length > 0) lines.push(`pids=""`);
  if (graph.cleanupFifos.length > 0) {
    lines.push(renderCleanup({
      cleanupFifos: graph.cleanupFifos,
      killBackgrounds: graph.backgrounds.length > 0,
    }));
    lines.push(`trap cleanup EXIT`);
  }
  for (const background of graph.backgrounds) lines.push(renderBackgroundProcess(background));
  lines.push(graph.foreground);
  if (graph.foregroundCodeVar) lines.push(`${graph.foregroundCodeVar}=$?`);
  if (graph.foregroundFailurePidVars.length > 0) {
    lines.push(renderForegroundFailureCheck(graph.foregroundCodeVar, graph.foregroundFailurePidVars));
  }
  for (const waitSpec of graph.waits) lines.push(renderWait(waitSpec));
  if (graph.cleanupBeforeChecks) {
    lines.push(`trap - EXIT`);
    lines.push(`cleanup`);
  }
  for (const check of graph.checks) lines.push(renderExitOnFailure(check.codeVar));
  return lines.join("\n");
}

function renderSinglePipeGraph(ctx) {
  return {
    backgrounds: [],
    checks: [],
    cleanupBeforeChecks: false,
    cleanupFifos: [],
    fifos: [],
    foreground: teeCommand(ctx.singleRuntimeStatsPlan, [ctx.statsErr, ctx.partnerStatsErr]),
    foregroundCodeVar: "",
    foregroundFailurePidVars: [],
    pipefail: false,
    removePaths: ctx.errorPaths,
    waits: [],
  };
}

function renderStdoutPrimaryGraph(ctx) {
  if (ctx.topology.singleRuntime) {
    return {
      backgrounds: [],
      checks: [{ codeVar: "pipeline_code" }],
      cleanupBeforeChecks: true,
      cleanupFifos: [ctx.originalFifo],
      fifos: [ctx.originalFifo],
      foreground: `${ctx.ffmpegStatsDecode} | ${teeCommand(ctx.singleRuntimeStatsPlan, [ctx.statsErr, ctx.partnerStatsErr])}`,
      foregroundCodeVar: "pipeline_code",
      foregroundFailurePidVars: [],
      pipefail: true,
      removePaths: [ctx.originalFifo, ...ctx.errorPaths],
      waits: [],
    };
  }

  return {
    backgrounds: [{ command: ctx.originalStatsPlan, pidVar: "pid_orig", teePaths: [ctx.partnerStatsErr] }],
    checks: [{ codeVar: "orig_code" }],
    cleanupBeforeChecks: true,
    cleanupFifos: [ctx.originalFifo],
    fifos: [ctx.originalFifo],
    foreground: `${ctx.ffmpegStatsDecode} | ${teeCommand(ctx.fallbackStatsPlan, [ctx.statsErr])}`,
    foregroundCodeVar: "pipeline_code",
    foregroundFailurePidVars: ["pid_orig"],
    pipefail: true,
    removePaths: [ctx.originalFifo, ...ctx.errorPaths],
    waits: [{ codeVar: "orig_code", pidVar: "pid_orig" }],
  };
}

function renderBufferedDecodeGraph(ctx) {
  const fifos = [ctx.fallbackFifo, ctx.originalFifo, ctx.fallbackRelayFifo, ctx.originalRelayFifo];
  return {
    backgrounds: [
      { command: ctx.fallbackStatsPlan, pidVar: "pid_fb", teePaths: [ctx.statsErr] },
      { command: ctx.originalStatsPlan, pidVar: "pid_orig", teePaths: [ctx.partnerStatsErr] },
      { command: ctx.fallbackRelayCommand, pidVar: "pid_fb_relay" },
      { command: ctx.originalRelayCommand, pidVar: "pid_orig_relay" },
    ],
    checks: [
      { codeVar: "fb_relay_code" },
      { codeVar: "orig_relay_code" },
      { codeVar: "fb_code" },
      { codeVar: "orig_code" },
    ],
    cleanupBeforeChecks: false,
    cleanupFifos: fifos,
    fifos,
    foreground: ctx.ffmpegStatsDecode,
    foregroundCodeVar: "ffmpeg_code",
    foregroundFailurePidVars: ["pid_fb", "pid_orig", "pid_fb_relay", "pid_orig_relay"],
    pipefail: false,
    removePaths: [...fifos, ...ctx.errorPaths],
    waits: [
      { codeVar: "fb_relay_code", pidVar: "pid_fb_relay" },
      { codeVar: "orig_relay_code", pidVar: "pid_orig_relay" },
      { codeVar: "fb_code", pidVar: "pid_fb" },
      { codeVar: "orig_code", pidVar: "pid_orig" },
    ],
  };
}

function renderRawTeeCpuGraph(ctx) {
  const fifos = [ctx.fallbackFifo, ctx.originalFifo, ctx.fallbackRelayFifo, ctx.originalRelayFifo, ctx.fallbackCpuFifo, ctx.originalCpuFifo];
  return {
    backgrounds: [
      { command: ctx.fallbackStatsPlan, pidVar: "pid_fb", teePaths: [ctx.statsErr] },
      { command: ctx.originalStatsPlan, pidVar: "pid_orig", teePaths: [ctx.partnerStatsErr] },
      { command: ctx.fallbackCpuMeasureCommand, pidVar: "pid_fb_cpu" },
      { command: ctx.originalCpuMeasureCommand, pidVar: "pid_orig_cpu" },
      { command: ctx.fallbackRelayCommand, pidVar: "pid_fb_relay" },
      { command: ctx.originalRelayCommand, pidVar: "pid_orig_relay" },
    ],
    checks: [
      { codeVar: "fb_relay_code" },
      { codeVar: "orig_relay_code" },
      { codeVar: "fb_code" },
      { codeVar: "orig_code" },
      { codeVar: "fb_cpu_code" },
      { codeVar: "orig_cpu_code" },
    ],
    cleanupBeforeChecks: false,
    cleanupFifos: fifos,
    fifos,
    foreground: ctx.ffmpegStatsDecode,
    foregroundCodeVar: "ffmpeg_code",
    foregroundFailurePidVars: ["pid_fb", "pid_orig", "pid_fb_cpu", "pid_orig_cpu", "pid_fb_relay", "pid_orig_relay"],
    pipefail: false,
    removePaths: [...fifos, ...ctx.errorPaths],
    waits: [
      { codeVar: "fb_relay_code", pidVar: "pid_fb_relay" },
      { codeVar: "orig_relay_code", pidVar: "pid_orig_relay" },
      { codeVar: "fb_code", pidVar: "pid_fb" },
      { codeVar: "orig_code", pidVar: "pid_orig" },
      { codeVar: "fb_cpu_code", pidVar: "pid_fb_cpu" },
      { codeVar: "orig_cpu_code", pidVar: "pid_orig_cpu" },
    ],
  };
}

function renderSingleRuntimeGraph(ctx) {
  const fifoPaths = [ctx.fallbackFifo, ctx.originalFifo];
  return {
    backgrounds: [{ command: ctx.singleRuntimeStatsPlan, pidVar: "pid_pair", teePaths: [ctx.statsErr, ctx.partnerStatsErr] }],
    checks: [{ codeVar: "pair_code" }],
    cleanupBeforeChecks: false,
    cleanupFifos: fifoPaths,
    fifos: fifoPaths,
    foreground: ctx.ffmpegStatsDecode,
    foregroundCodeVar: "ffmpeg_code",
    foregroundFailurePidVars: ["pid_pair"],
    pipefail: false,
    removePaths: [...fifoPaths, ...ctx.errorPaths],
    waits: [{ codeVar: "pair_code", pidVar: "pid_pair" }],
  };
}

function renderDualRuntimeGraph(ctx) {
  const fifoPaths = [ctx.fallbackFifo, ctx.originalFifo];
  return {
    backgrounds: [
      { command: ctx.fallbackStatsPlan, pidVar: "pid_fb", teePaths: [ctx.statsErr] },
      { command: ctx.originalStatsPlan, pidVar: "pid_orig", teePaths: [ctx.partnerStatsErr] },
    ],
    checks: [{ codeVar: "fb_code" }, { codeVar: "orig_code" }],
    cleanupBeforeChecks: false,
    cleanupFifos: fifoPaths,
    fifos: fifoPaths,
    foreground: ctx.ffmpegStatsDecode,
    foregroundCodeVar: "ffmpeg_code",
    foregroundFailurePidVars: ["pid_fb", "pid_orig"],
    pipefail: false,
    removePaths: [...fifoPaths, ...ctx.errorPaths],
    waits: [{ codeVar: "fb_code", pidVar: "pid_fb" }, { codeVar: "orig_code", pidVar: "pid_orig" }],
  };
}

const PAIRED_SPLIT_STATS_RENDERERS = Object.freeze({
  [PAIRED_SPLIT_STATS_TOPOLOGY.BUFFERED_DECODE]: renderBufferedDecodeGraph,
  [PAIRED_SPLIT_STATS_TOPOLOGY.DUAL_RUNTIME]: renderDualRuntimeGraph,
  [PAIRED_SPLIT_STATS_TOPOLOGY.RAW_TEE_CPU]: renderRawTeeCpuGraph,
  [PAIRED_SPLIT_STATS_TOPOLOGY.SINGLE_PIPE]: renderSinglePipeGraph,
  [PAIRED_SPLIT_STATS_TOPOLOGY.SINGLE_RUNTIME]: renderSingleRuntimeGraph,
  [PAIRED_SPLIT_STATS_TOPOLOGY.STDOUT_PRIMARY]: renderStdoutPrimaryGraph,
});

function createPairedSplitStatsProcessGraph(opts) {
  const renderer = PAIRED_SPLIT_STATS_RENDERERS[opts.topology.kind];
  if (!renderer) throw new Error(`unknown paired split stats topology: ${opts.topology.kind || "missing"}`);
  return renderer({
    ...opts,
    errorPaths: pairedStatsErrorPaths(opts),
  });
}

function buildPairedSplitStatsScriptVariant(opts) {
  return renderProcessGraph(createPairedSplitStatsProcessGraph(opts));
}

module.exports = {
  buildPairedSplitStatsScriptVariant,
};
