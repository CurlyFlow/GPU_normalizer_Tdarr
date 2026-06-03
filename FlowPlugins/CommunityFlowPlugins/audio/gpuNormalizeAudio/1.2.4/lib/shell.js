"use strict";

const fs = require("fs");
const childProcess = require("child_process");
const { cleanLogText } = require("./common");

const MAX_CAPTURED_OUTPUT_CHARS = 100000;

function terminateShellProcess(proc, signal = "SIGTERM") {
  if (!proc || proc.killed) return;
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

function createShellOutputCapture({ args, capturePath, parseLine }) {
  const outputChunks = [];
  const capture = capturePath ? fs.createWriteStream(capturePath, { flags: "w" }) : null;
  let capturedOutputChars = 0;
  let lineBuffer = "";

  const handleData = (data) => {
    const text = String(data);
    if (capture) capture.write(text);
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
    lines.forEach(parseLine);
  };

  return {
    close: () => { if (capture) capture.end(); },
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
  const args = opts.args;
  const allowedCodes = opts.allowedCodes || [0];
  const capturePath = opts.capturePath || "";
  const parseLine = typeof opts.parseLine === "function" ? opts.parseLine : () => {};
  const logOnSuccess = opts.logOnSuccess === true;
  const processGroup = opts.processGroup || null;
  const startedAt = Date.now();
  args.jobLog(`GPU Normalize Audio step: ${opts.label}`);
  return new Promise((resolve) => {
    const outputCapture = createShellOutputCapture({ args, capturePath, parseLine });
    const proc = childProcess.spawn("/bin/bash", ["-lc", command], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cleanupProcess = trackProcessLifetime(proc, processGroup);
    proc.stdout.on("data", outputCapture.handleData);
    proc.stderr.on("data", outputCapture.handleData);
    proc.on("error", (err) => {
      cleanupProcess();
      outputCapture.close();
      args.jobLog(`Error running ${opts.label}: ${err.message}`);
      resolve({ code: 1, output: outputCapture.output(), wallSec: (Date.now() - startedAt) / 1000 });
    });
    proc.on("close", (code) => {
      cleanupProcess();
      outputCapture.flushLine();
      outputCapture.close();
      const output = outputCapture.output();
      if (!allowedCodes.includes(code)) {
        args.jobLog(`${opts.label} exited with code ${code}`);
        const cleaned = cleanLogText(output).slice(-50000);
        if (cleaned) args.jobLog(cleaned);
      } else if (logOnSuccess && args.logFullCliOutput !== true) {
        const cleaned = cleanLogText(output).slice(-50000);
        if (cleaned) args.jobLog(cleaned);
      }
      resolve({ code, output, wallSec: (Date.now() - startedAt) / 1000 });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  runShell,
  sleep,
  terminateShellProcess,
};
