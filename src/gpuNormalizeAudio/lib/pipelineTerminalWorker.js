"use strict";

const path = require("node:path");
const { runOwnedJsonProcess } = require("./mediaVerificationProcess");

function terminalFailure(output) {
  let category = "";
  try {
    const value = JSON.parse(output);
    if (/^[A-Za-z]+Error$/.test(value.error) && /^[a-z_]+\.py:\d+$/.test(value.failureLocation)) {
      category = ` (${value.error}, ${value.failureLocation})`;
      if (["TDARR_OWNER_MISSING", "TDARR_OWNER_CONFLICT", "TDARR_OWNER_MISMATCH", "TDARR_COMPANION_PENDING"].includes(value.failureCode)) {
        category += ` ${value.failureCode}`;
      }
    }
  } catch { /* Never emit raw worker diagnostics. */ }
  return Error(`Finished package held; no import was requested${category}`);
}

async function runTerminalWorker(args, request, phase) {
  const phases = {
    replacement: [14430000, "Retaining the admitted original before installing verified finished media."],
    publication: [14430000, "Finished-media validation is still running; no import has been requested."],
    rejectionAudit: [14430000, "Input fingerprint and decision evidence are still being recorded."],
    rejection: [210000, "Waiting for native downloader rejection acknowledgement."],
    repairAudit: [14430000, "Recording the repaired working file and unchanged source evidence."],
    qualityRejection: [14430000, "Verifying the current non-upgrade decision and acknowledged cleanup."],
    processingAudit: [14430000, "Recording original identity, expected outcome and actual publication evidence."],
  };
  if (!Object.hasOwn(phases, phase)) throw Error("Unknown terminal worker phase");
  const config = args.configVars?.config;
  if (typeof config?.serverURL !== "string" || !config.serverURL) {
    throw Error("Tdarr did not supply the helper's runtime connection");
  }
  // The native connection stays in private child stdin, never Flow variables,
  // logs, decision evidence or a guessed on-disk configuration location.
  const input = { ...request,
    tdarr: { serverURL: config.serverURL, "apiKey": String(config.apiKey || "") } };
  if (Buffer.byteLength(JSON.stringify(input)) > 4 * 1024 * 1024) throw Error("Finished package request is oversized");
  const argv = ["-B", path.join(__dirname, "../runtime/bin/media_terminal_step.py")];
  if (process.platform !== "win32") argv.push("--owned-process-group");
  return await runOwnedJsonProcess(process.env.PYTHON || "python3", argv, input, value => {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.error) throw Error("Invalid result");
  }, {
    timeoutMs: phases[phase][0], onProgress: () => args.jobLog(phases[phase][1]), failure: terminalFailure,
    startError: "Finished package worker could not start", invalidError: "Finished package worker returned an invalid result",
  });
}

module.exports = { runTerminalWorker };
