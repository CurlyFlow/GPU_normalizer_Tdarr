"use strict";

const { spawn } = require("node:child_process");
const MAX_BYTES = 4 * 1024 * 1024;

// Media workers share one process-group, progress and cancellation owner.
async function runVerificationProcess(worker, request, validate, { signal, onProgress = () => {}, timeoutMs = 14430000 } = {}) {
  return await runOwnedJsonProcess(process.execPath, [worker, "--worker"], request, validate,
    { signal, onProgress, timeoutMs });
}

async function runOwnedJsonProcess(executable, argv, request, validate, {
  signal, onProgress = () => {}, timeoutMs = 14430000,
  failure = () => Error("Media verification incomplete; original retained"),
  startError = "Media verification worker could not start",
  invalidError = "Media verification worker returned an invalid result",
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 14430000) throw Error("Invalid media verification deadline");
  if (signal?.aborted) throw Error("Media verification cancelled");
  const input = JSON.stringify(request);
  if (!input || Buffer.byteLength(input) > MAX_BYTES) throw Error("Media verification request is oversized or empty");
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, argv,
      { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let output = "", failed = false, escalation;
    const kill = signalName => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch { /* The owned group may already have exited. */ }
    };
    const stop = () => {
      if (failed) return;
      failed = true;
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 5000);
    };
    const exit = () => kill("SIGTERM");
    process.once("exit", exit);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const deadline = setTimeout(stop, timeoutMs);
    const progress = setInterval(() => { try { onProgress(); } catch { stop(); } }, 60000);
    const cleanup = () => {
      clearTimeout(deadline); clearTimeout(escalation); clearInterval(progress);
      process.removeListener("exit", exit); signal?.removeEventListener("abort", stop);
    };
    child.stdout.on("data", chunk => {
      if (failed) return;
      output += chunk.toString();
      if (Buffer.byteLength(output) > MAX_BYTES) { output = ""; stop(); }
    });
    child.stderr.on("data", stop);
    child.stdin.on("error", stop);
    child.on("error", () => { cleanup(); reject(Error(startError)); });
    child.on("close", code => {
      // Root exit is not process-tree settlement. A reference subprocess can
      // close inherited pipes and survive the worker, including after SIGTERM.
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, 0); failed = true; kill("SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") { failed = true; kill("SIGKILL"); } }
      }
      cleanup();
      if (failed || code !== 0) return reject(failure(output));
      try {
        const value = JSON.parse(output);
        validate(value, request);
        return resolve(value);
      } catch { return reject(Error(invalidError)); }
    });
    child.stdin.end(input);
  });
}

function serveVerificationWorker(owner, verify) {
  if (require.main !== owner) return;
  process.umask(0o077);
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_BYTES) process.exit(1);
  });
  process.stdin.on("end", async () => {
    try {
      if (process.argv.length !== 3 || process.argv[2] !== "--worker") throw Error("Invalid media worker invocation");
      process.stdout.write(JSON.stringify(await verify(JSON.parse(input))));
    } catch { process.exitCode = 1; }
  });
}

module.exports = { runVerificationProcess, runOwnedJsonProcess, serveVerificationWorker };
