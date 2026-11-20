"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { intNum } = require("./common");
const { sleep } = require("./shell");

function tryAcquireSlot(args, base, slot, maxConcurrent, resource) {
  const file = `${base}.slot${slot}.flock`;
  const descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  let acquired = false;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("GPU normalize lock must be a regular non-linked file");
    // flock belongs to the shared open-file description. The helper exits, but
    // this process's descriptor keeps the kernel lock until close or process exit.
    const result = spawnSync(String(process.env.PYTHON || "python3"), [
      path.join(__dirname, "../runtime/bin/gpu_job_lock.py"),
    ], { stdio: ["ignore", "ignore", "pipe", descriptor], timeout: 5000, maxBuffer: 4096 });
    if (result.error || result.signal) throw new Error("GPU normalize kernel lock helper failed");
    if (result.status === 75) return null;
    if (result.status !== 0) throw new Error("GPU normalize kernel lock is unavailable");
    const current = fs.lstatSync(file);
    if (current.dev !== stat.dev || current.ino !== stat.ino) throw new Error("GPU normalize lock path changed during acquisition");
    fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, slot, maxConcurrent, acquiredAt: new Date().toISOString() }) + "\n");
    acquired = true;
  } finally {
    if (!acquired) fs.closeSync(descriptor);
  }
  try {
    args.jobLog(`Acquired ${resource} slot ${slot}/${maxConcurrent}`);
  } catch (err) {
    fs.closeSync(descriptor);
    throw err;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.closeSync(descriptor);
    // Never unlink a lock inode: another process may already be waiting on it.
    args.jobLog(`Released ${resource} slot ${slot}/${maxConcurrent}`);
  };
}

async function acquireConcurrencyLock(args, lockFileInput, maxConcurrentInput, resource = "GPU normalize") {
  const parsed = intNum(maxConcurrentInput, 1);
  const maxConcurrent = parsed < 0 ? 1 : Math.min(parsed, 32);
  if (maxConcurrent === 0) {
    args.jobLog(`${resource} guarded lock disabled: max_concurrent=0`);
    return () => {};
  }
  const base = String(lockFileInput || "/tmp/opx_tdarr_gpu_normalize.lock").trim() || "/tmp/opx_tdarr_gpu_normalize.lock";
  if (!path.isAbsolute(base) || fs.realpathSync(path.dirname(base)) !== path.dirname(base)) {
    throw new Error("GPU normalize lock base must use a canonical absolute parent directory");
  }
  const waitStartedAt = Date.now();
  let lastBusyLogAt = 0;
  while (true) {
    // Previous public versions use directory leases. Never infer their death
    // from timestamps or /proc access failures, or run mixed lease protocols.
    for (let slot = 1; slot <= 32; slot += 1) {
      try {
        fs.lstatSync(`${base}.slot${slot}.lockdir`);
      } catch (err) {
        if (err.code === "ENOENT") continue;
        throw err;
      }
      throw new Error("Legacy GPU normalize slot exists; drain old-version workers and verify slot ownership before migrating");
    }
    for (let slot = 1; slot <= maxConcurrent; slot += 1) {
      const release = tryAcquireSlot(args, base, slot, maxConcurrent, resource);
      if (release) return release;
    }
    const now = Date.now();
    if (lastBusyLogAt === 0 || now - lastBusyLogAt >= 60000) {
      args.jobLog(`All ${maxConcurrent} ${resource} slots busy; checking every 10s (waited ${Math.round((now - waitStartedAt) / 1000)}s)`);
      lastBusyLogAt = now;
    }
    await sleep(10000);
  }
}

async function runResourceTask(args, resource, task) {
  if (!["cpu", "gpu"].includes(resource)) throw new Error("Unknown processing resource");
  const cpu = resource === "cpu";
  const base = cpu ? (args.inputs.cpuLockFile || "/tmp/opx_tdarr_cpu_processing.lock") : args.inputs.lockFile;
  const limit = cpu ? args.inputs.maxConcurrentCpuJobs : args.inputs.maxConcurrentJobs;
  const release = await acquireConcurrencyLock(args, base, limit, cpu ? "CPU processing" : "GPU normalize");
  try { return await task(); } finally { release(); }
}

module.exports = { acquireConcurrencyLock, runResourceTask };
