"use strict";

const fs = require("fs");
const childProcess = require("child_process");
const { cleanLogText } = require("./common");

const MAX_CAPTURED_OUTPUT_CHARS = 100000;

function terminateShellProcess(proc, signal = "SIGTERM") {
  if (!proc || (proc.killed && signal !== "SIGKILL")) return;
  if (process.platform !== "win32" && proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch (_) {
      // Fall back to the shell process if process-group termination is not available.
    }
  }
  try { proc.kill(signal); } catch (_) { /* noop */ }
}

function cancelShellProcessGroup(group) {
  group.cancelled = true;
  for (const proc of Array.from(group.procs)) {
    terminateShellProcess(proc);
    const deadline = setTimeout(() => terminateShellProcess(proc, "SIGKILL"), 2000);
    deadline.unref();
    proc.once("close", () => clearTimeout(deadline));
  }
}

function createShellOutputCapture({ args, capturePath, parseLine }) {
  const outputChunks = [];
  let capture = capturePath ? fs.openSync(capturePath, "w") : null;
  let capturedOutputChars = 0;
  let lineBuffer = "";

  const handleData = (data) => {
    const text = String(data);
    if (capture !== null) fs.writeFileSync(capture, text);
    outputChunks.push(text);
    capturedOutputChars += text.length;
    while (capturedOutputChars > MAX_CAPTURED_OUTPUT_CHARS && outputChunks.length > 0) {
      const removed = outputChunks.shift();
      capturedOutputChars -= removed.length;
    }
    if (args.logFullCliOutput === true) args.jobLog(text);
    lineBuffer += text.replace(/\r/g, "\n");
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() || "";
    if (lineBuffer.length > MAX_CAPTURED_OUTPUT_CHARS || lines.some((line) => line.length > MAX_CAPTURED_OUTPUT_CHARS)) {
      lineBuffer = "";
      throw new Error("GPU normalize command output line exceeds capture limit");
    }
    lines.forEach(parseLine);
  };

  return {
    close: () => {
      if (capture !== null) {
        const descriptor = capture;
        capture = null;
        fs.closeSync(descriptor);
      }
    },
    flushLine: () => { if (lineBuffer) parseLine(lineBuffer); },
    handleData,
    output: () => outputChunks.join(""),
  };
}

function trackProcessLifetime(proc, processGroup) {
  if (processGroup) {
    processGroup.procs.add(proc);
    if (processGroup.cancelled) {
      terminateShellProcess(proc);
    }
  }
  const exitHandler = () => {
    terminateShellProcess(proc);
  };
  process.once("exit", exitHandler);
  return () => {
    process.removeListener("exit", exitHandler);
    if (processGroup) processGroup.procs.delete(proc);
  };
}

function runShell(command, opts) {
  if (opts.processGroup?.cancelled) return Promise.reject(new Error("GPU normalize job work was cancelled"));
  const args = opts.args;
  const allowedCodes = opts.allowedCodes || [0];
  const capturePath = opts.capturePath || "";
  const parseLine = typeof opts.parseLine === "function" ? opts.parseLine : () => {};
  const logOnSuccess = opts.logOnSuccess === true;
  const processGroup = opts.processGroup || null;
  const startedAt = Date.now();
  args.jobLog(`GPU Normalize Audio step: ${opts.label}`);
  return new Promise((resolve) => {
    let stepError = null;
    const outputCapture = createShellOutputCapture({ args, capturePath, parseLine });
    const proc = childProcess.spawn("/bin/bash", ["-lc", command], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cleanupProcess = trackProcessLifetime(proc, processGroup);
    const fail = (err) => {
      if (!stepError) stepError = err;
      terminateShellProcess(proc);
    };
    const handleData = (data) => {
      if (stepError) return;
      try { outputCapture.handleData(data); } catch (err) { fail(err); }
    };
    proc.stdout.on("data", handleData);
    proc.stderr.on("data", handleData);
    proc.on("error", (err) => {
      fail(err);
    });
    proc.on("close", (code, signal) => {
      cleanupProcess();
      try {
        if (!stepError) outputCapture.flushLine();
      } catch (err) { stepError = err; }
      try { outputCapture.close(); } catch (err) { if (!stepError) stepError = err; }
      if (stepError) {
        args.jobLog(`Error running ${opts.label}: ${stepError.message}`);
        code = 1;
      }
      const output = outputCapture.output();
      if (!allowedCodes.includes(code)) {
        args.jobLog(`${opts.label} exited with code ${code}${signal ? ` signal ${signal}` : ""}`);
        const cleaned = cleanLogText(output).slice(-50000);
        if (cleaned) args.jobLog(cleaned);
      } else if (logOnSuccess && args.logFullCliOutput !== true) {
        const cleaned = cleanLogText(output).slice(-50000);
        if (cleaned) args.jobLog(cleaned);
      }
      resolve({ code, signal: signal || null, output, wallSec: (Date.now() - startedAt) / 1000 });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  cancelShellProcessGroup,
  runShell,
  sleep,
  terminateShellProcess,
};
