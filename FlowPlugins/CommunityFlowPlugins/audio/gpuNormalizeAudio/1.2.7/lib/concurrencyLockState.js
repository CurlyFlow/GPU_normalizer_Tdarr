"use strict";

const fs = require("fs");
const { intNum } = require("./common");

function maxConcurrentJobs(value) {
  const parsed = intNum(value, 1);
  if (parsed < 0) return 1;
  return Math.min(parsed, 32);
}

function holderPidForLock(dir) {
  try {
    const firstLine = fs.readFileSync(`${dir}/holder`, "utf8").split(/\r?\n/, 1)[0].trim();
    const pid = Number.parseInt(firstLine, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (_) {
    return null;
  }
}

function procStatusPpid(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^PPid:\s+(\d+)$/m);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch (_) {
    return null;
  }
}

function procCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch (_) {
    return "";
  }
}

function holderHasActiveNormalizeDescendant(holderPid) {
  try {
    const ppidByPid = new Map();
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number.parseInt(entry, 10);
      const ppid = procStatusPpid(pid);
      if (ppid !== null) ppidByPid.set(pid, ppid);
    }
    const isDescendant = (pid) => {
      let current = pid;
      for (let depth = 0; depth < 32; depth += 1) {
        const ppid = ppidByPid.get(current);
        if (ppid === holderPid) return true;
        if (!ppid || ppid === current) return false;
        current = ppid;
      }
      return false;
    };
    for (const pid of ppidByPid.keys()) {
      if (!isDescendant(pid)) continue;
      const cmdline = procCmdline(pid);
      if (cmdline.includes("tdarr-ffmpeg") || cmdline.includes("loudnorm") || cmdline.includes("gpu-normalize") || cmdline.includes("loudnorm-gpu-source-port")) return true;
    }
  } catch (_) {
    return false;
  }
  return false;
}

module.exports = {
  holderHasActiveNormalizeDescendant,
  holderPidForLock,
  maxConcurrentJobs,
};
