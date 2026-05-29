"use strict";

const fs = require("fs");
const childProcess = require("child_process");
const { cleanLogText } = require("./common");

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
      const outputChunks = [];
      let capturedOutputChars = 0;
      let lineBuffer = "";
    const capture = capturePath ? fs.createWriteStream(capturePath, { flags: "w" }) : null;
    const proc = childProcess.spawn("/bin/bash", ["-lc", command], { stdio: ["ignore", "pipe", "pipe"] });
    if (processGroup) {
      processGroup.procs.add(proc);
      if (processGroup.cancelled) {
        try { proc.kill("SIGTERM"); } catch (_) { /* noop */ }
      }
    }
    const exitHandler = () => {
      try { proc.kill("SIGTERM"); } catch (_) { /* noop */ }
    };
    process.once("exit", exitHandler);
      const handleData = (data) => {
        const text = String(data);
        if (capture) capture.write(text);
        outputChunks.push(text);
        capturedOutputChars += text.length;
        while (capturedOutputChars > 100000 && outputChunks.length > 0) {
          const removed = outputChunks.shift();
          capturedOutputChars -= removed.length;
        }
        if (args.logFullCliOutput === true) args.jobLog(text);
      lineBuffer += text.replace(/\r/g, "\n");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";
      lines.forEach(parseLine);
    };
    proc.stdout.on("data", handleData);
    proc.stderr.on("data", handleData);
    proc.on("error", (err) => {
      process.removeListener("exit", exitHandler);
      if (processGroup) processGroup.procs.delete(proc);
      if (capture) capture.end();
      args.jobLog(`Error running ${opts.label}: ${err.message}`);
      resolve({ code: 1, output: outputChunks.join(""), wallSec: (Date.now() - startedAt) / 1000 });
    });
    proc.on("close", (code) => {
      process.removeListener("exit", exitHandler);
      if (processGroup) processGroup.procs.delete(proc);
      if (lineBuffer) parseLine(lineBuffer);
      if (capture) capture.end();
      const output = outputChunks.join("");
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
};
