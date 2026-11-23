"use strict";

const path = require("path");
const { spawn } = require("child_process");

async function recoverPublishedFile(request) {
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 32768) throw new Error("Import recovery request exceeds its bound");
  return await new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON || "python3", [
      "-B", path.join(__dirname, "../runtime/bin/arr_recover_published.py"),
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let failed = false;
    const stop = () => { failed = true; child.kill("SIGKILL"); };
    const timer = setTimeout(stop, 300000);
    child.stdout.on("data", (chunk) => {
      if (Buffer.byteLength(output) + chunk.length > 65536) stop();
      else output += chunk.toString();
    });
    child.stderr.on("data", stop);
    child.stdin.on("error", stop);
    child.on("error", () => { clearTimeout(timer); reject(new Error("Import recovery could not start")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) {
        reject(new Error("Import recovery is not proven; retain its receipt before retrying"));
        return;
      }
      try {
        const result = JSON.parse(output);
        if (result.imported !== true && result.recoveryRequired !== false) throw new Error("Unproven import");
        resolve(result);
      } catch {
        reject(new Error("Import recovery returned no valid import evidence"));
      }
    });
    child.stdin.end(input);
  });
}

module.exports = { recoverPublishedFile };
