"use strict";

const fs = require("fs");
const { sleep } = require("./shell");
const {
  holderHasActiveNormalizeDescendant,
  holderPidForLock,
  maxConcurrentJobs,
} = require("./concurrencyLockState");

const LOCK_HEARTBEAT_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = LOCK_HEARTBEAT_MS + 60 * 1000;

async function acquireConcurrencyLock(args, lockFileInput, maxConcurrentInput) {
  const maxConcurrent = maxConcurrentJobs(maxConcurrentInput);
  if (maxConcurrent === 0) {
    args.jobLog("GPU normalize guarded lock disabled: max_concurrent=0");
    return () => {};
  }
  const base = String(lockFileInput || "/tmp/opx_tdarr_gpu_normalize.lock").trim() || "/tmp/opx_tdarr_gpu_normalize.lock";
  const waitStartedAt = Date.now();
  let lastBusyLogAt = 0;
  while (true) {
    for (let slot = 1; slot <= maxConcurrent; slot += 1) {
      const dir = `${base}.slot${slot}.lockdir`;
      try {
        fs.mkdirSync(dir);
        const writeHeartbeat = () => {
          const stamp = `${process.pid}\n${new Date().toISOString()}\nslot=${slot}\nmax=${maxConcurrent}\n`;
          fs.writeFileSync(`${dir}/holder`, stamp);
          fs.writeFileSync(`${dir}/heartbeat`, stamp);
        };
        writeHeartbeat();
        const heartbeat = setInterval(() => {
          try {
            writeHeartbeat();
          } catch (err) {
            args.jobLog(`Failed to refresh GPU normalize slot ${slot}/${maxConcurrent}: ${err.message}`);
          }
        }, LOCK_HEARTBEAT_MS);
        if (heartbeat.unref) heartbeat.unref();
        args.jobLog(`Acquired GPU normalize slot ${slot}/${maxConcurrent}: ${dir}`);
        return () => {
          clearInterval(heartbeat);
          fs.rmSync(dir, { recursive: true, force: true });
          args.jobLog(`Released GPU normalize slot ${slot}/${maxConcurrent}: ${dir}`);
        };
      } catch (err) {
        if (!err || err.code !== "EEXIST") throw err;
        const heartbeatPath = `${dir}/heartbeat`;
        let stat;
        try {
          stat = fs.statSync(heartbeatPath);
        } catch (statErr) {
          if (statErr && statErr.code === "ENOENT") {
            try {
              stat = fs.statSync(`${dir}/holder`);
            } catch (holderErr) {
              if (holderErr && holderErr.code === "ENOENT") stat = fs.statSync(dir);
              else throw holderErr;
            }
          } else {
            throw statErr;
          }
        }
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > LOCK_STALE_MS) {
          const holderPid = holderPidForLock(dir);
          if (holderPid !== null && holderHasActiveNormalizeDescendant(holderPid)) {
            try {
              fs.copyFileSync(`${dir}/holder`, heartbeatPath);
            } catch (refreshErr) {
              args.jobLog(`Failed to refresh observed active GPU normalize slot ${slot}/${maxConcurrent}: ${refreshErr.message}`);
            }
            args.jobLog(`Preserving active GPU normalize slot ${slot}/${maxConcurrent}: ${dir} holder pid ${holderPid}`);
            continue;
          }
          args.jobLog(`Removing stale GPU normalize slot ${slot}/${maxConcurrent}: ${dir} heartbeat age ${Math.round(ageMs / 1000)}s`);
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    }
    const now = Date.now();
    if (lastBusyLogAt === 0 || now - lastBusyLogAt >= 60000) {
      args.jobLog(`All ${maxConcurrent} GPU normalize slots busy; checking every 10s (waited ${Math.round((now - waitStartedAt) / 1000)}s): ${base}.slotN.lockdir`);
      lastBusyLogAt = now;
    }
    await sleep(10000);
  }
}

module.exports = {
  acquireConcurrencyLock,
};
