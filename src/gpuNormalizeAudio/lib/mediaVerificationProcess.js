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
  failure = (_output, reason) => Error(reason
    ? `Media verification incomplete (${reason}); original retained`
    : "Media verification incomplete; original retained"),
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
    let output = "", stderrSample = "", failed = false, failReason = "", escalation;
    const kill = signalName => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch { /* The owned group may already have exited. */ }
    };
    const stop = (reason = "stopped") => {
      if (!failReason && reason) failReason = reason;
      if (failed) return;
      failed = true;
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 5000);
    };
    const exit = () => kill("SIGTERM");
    process.once("exit", exit);
    const onAbort = () => stop("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) stop("aborted");
    const deadline = setTimeout(() => stop("timeout"), timeoutMs);
    const progress = setInterval(() => { try { onProgress(); } catch { stop("progress_error"); } }, 60000);
    const cleanup = () => {
      clearTimeout(deadline); clearTimeout(escalation); clearInterval(progress);
      process.removeListener("exit", exit); signal?.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", chunk => {
      if (failed) return;
      output += chunk.toString();
      if (Buffer.byteLength(output) > MAX_BYTES) { output = ""; stop("stdout_overflow"); }
    });
    child.stderr.on("data", chunk => {
      if (stderrSample.length < 300) stderrSample += chunk.toString("utf8").replace(/[\r\n]+/g, " ").slice(0, 300 - stderrSample.length);
      stop("stderr");
    });
    child.stdin.on("error", () => stop("stdin_error"));
    child.on("error", () => { cleanup(); reject(Error(startError)); });
    child.on("close", (code, closeSignal) => {
      // Root exit is not process-tree settlement. A reference subprocess can
      // close inherited pipes and survive the worker, including after SIGTERM.
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, 0); failed = true; failReason ||= "live_descendant"; kill("SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") { failed = true; failReason ||= "live_descendant"; kill("SIGKILL"); } }
      }
      cleanup();
      if (failed || code !== 0) {
        let detail = failReason;
        if (detail === "stderr" && stderrSample.trim()) detail = `stderr: ${stderrSample.trim()}`;
        if (!detail) {
          try {
            const parsed = JSON.parse(output);
            if (typeof parsed?.__workerError === "string" && parsed.__workerError) detail = parsed.__workerError;
          } catch {}
        }
        if (!detail) detail = closeSignal ? `signal=${closeSignal}` : `exit_code=${code}`;
        return reject(failure(output, detail));
      }
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
    } catch (error) {
      try {
        const detail = `${error?.name || "Error"}: ${String(error?.message || "unknown").replace(/[\r\n]+/g, " ").slice(0, 300)}`;
        process.stdout.write(JSON.stringify({ __workerError: detail }));
      } catch {}
      process.exitCode = 1;
    }
  });
}

module.exports = { runVerificationProcess, runOwnedJsonProcess, serveVerificationWorker };
