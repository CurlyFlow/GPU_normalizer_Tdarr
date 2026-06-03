"use strict";

const {
  q,
} = require("./common");

function qList(paths) {
  return paths.map((entry) => q(entry)).join(" ");
}

function pairedStatsErrorPaths({ fusePairedCpuMeasure, partnerStatsErr, plan, statsErr }) {
  return [
    statsErr,
    partnerStatsErr,
    fusePairedCpuMeasure ? plan.measureErr : null,
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

function createPairedSplitStatsProcessGraph({
  fallbackFifo,
  fallbackRelayFifo,
  fallbackRelayCommand,
  fallbackStatsPlan,
  ffmpegStatsDecode,
  fusePairedCpuMeasure,
  originalFifo,
  originalRelayFifo,
  originalRelayCommand,
  originalStatsPlan,
  partnerStatsErr,
  plan,
  singleRuntimeStatsPlan,
  statsErr,
  useSinglePipe,
  useSingleRuntime,
  useStdoutPrimary,
  useBufferedDecode,
}) {
  const errorPaths = pairedStatsErrorPaths({
    fusePairedCpuMeasure,
    partnerStatsErr,
    plan,
    statsErr,
  });

  if (useSinglePipe) {
    return {
      backgrounds: [],
      checks: [],
      cleanupBeforeChecks: false,
      cleanupFifos: [],
      fifos: [],
      foreground: teeCommand(singleRuntimeStatsPlan, [statsErr, partnerStatsErr]),
      foregroundCodeVar: "",
      foregroundFailurePidVars: [],
      pipefail: false,
      removePaths: errorPaths,
      waits: [],
    };
  }

  if (useStdoutPrimary && useSingleRuntime) {
    return {
      backgrounds: [],
      checks: [{ codeVar: "pipeline_code" }],
      cleanupBeforeChecks: true,
      cleanupFifos: [originalFifo],
      fifos: [originalFifo],
      foreground: `${ffmpegStatsDecode} | ${teeCommand(singleRuntimeStatsPlan, [statsErr, partnerStatsErr])}`,
      foregroundCodeVar: "pipeline_code",
      foregroundFailurePidVars: [],
      pipefail: true,
      removePaths: [originalFifo, ...errorPaths],
      waits: [],
    };
  }

  if (useStdoutPrimary) {
    return {
      backgrounds: [{ command: originalStatsPlan, pidVar: "pid_orig", teePaths: [partnerStatsErr] }],
      checks: [{ codeVar: "orig_code" }],
      cleanupBeforeChecks: true,
      cleanupFifos: [originalFifo],
      fifos: [originalFifo],
      foreground: `${ffmpegStatsDecode} | ${teeCommand(fallbackStatsPlan, [statsErr])}`,
      foregroundCodeVar: "pipeline_code",
      foregroundFailurePidVars: ["pid_orig"],
      pipefail: true,
      removePaths: [originalFifo, ...errorPaths],
      waits: [{ codeVar: "orig_code", pidVar: "pid_orig" }],
    };
  }

  if (useBufferedDecode) {
    const fifos = [fallbackFifo, originalFifo, fallbackRelayFifo, originalRelayFifo];
    return {
      backgrounds: [
        { command: fallbackStatsPlan, pidVar: "pid_fb", teePaths: [statsErr] },
        { command: originalStatsPlan, pidVar: "pid_orig", teePaths: [partnerStatsErr] },
        { command: fallbackRelayCommand, pidVar: "pid_fb_relay" },
        { command: originalRelayCommand, pidVar: "pid_orig_relay" },
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
      foreground: ffmpegStatsDecode,
      foregroundCodeVar: "ffmpeg_code",
      foregroundFailurePidVars: ["pid_fb", "pid_orig", "pid_fb_relay", "pid_orig_relay"],
      pipefail: false,
      removePaths: [...fifos, ...errorPaths],
      waits: [
        { codeVar: "fb_relay_code", pidVar: "pid_fb_relay" },
        { codeVar: "orig_relay_code", pidVar: "pid_orig_relay" },
        { codeVar: "fb_code", pidVar: "pid_fb" },
        { codeVar: "orig_code", pidVar: "pid_orig" },
      ],
    };
  }

  const fifoPaths = [fallbackFifo, originalFifo];
  if (useSingleRuntime) {
    return {
      backgrounds: [{ command: singleRuntimeStatsPlan, pidVar: "pid_pair", teePaths: [statsErr, partnerStatsErr] }],
      checks: [{ codeVar: "pair_code" }],
      cleanupBeforeChecks: false,
      cleanupFifos: fifoPaths,
      fifos: fifoPaths,
      foreground: ffmpegStatsDecode,
      foregroundCodeVar: "ffmpeg_code",
      foregroundFailurePidVars: ["pid_pair"],
      pipefail: false,
      removePaths: [...fifoPaths, ...errorPaths],
      waits: [{ codeVar: "pair_code", pidVar: "pid_pair" }],
    };
  }

  return {
    backgrounds: [
      { command: fallbackStatsPlan, pidVar: "pid_fb", teePaths: [statsErr] },
      { command: originalStatsPlan, pidVar: "pid_orig", teePaths: [partnerStatsErr] },
    ],
    checks: [{ codeVar: "fb_code" }, { codeVar: "orig_code" }],
    cleanupBeforeChecks: false,
    cleanupFifos: fifoPaths,
    fifos: fifoPaths,
    foreground: ffmpegStatsDecode,
    foregroundCodeVar: "ffmpeg_code",
    foregroundFailurePidVars: ["pid_fb", "pid_orig"],
    pipefail: false,
    removePaths: [...fifoPaths, ...errorPaths],
    waits: [{ codeVar: "fb_code", pidVar: "pid_fb" }, { codeVar: "orig_code", pidVar: "pid_orig" }],
  };
}

function buildPairedSplitStatsScriptVariant(opts) {
  return renderProcessGraph(createPairedSplitStatsProcessGraph(opts));
}

module.exports = {
  buildPairedSplitStatsScriptVariant,
};
