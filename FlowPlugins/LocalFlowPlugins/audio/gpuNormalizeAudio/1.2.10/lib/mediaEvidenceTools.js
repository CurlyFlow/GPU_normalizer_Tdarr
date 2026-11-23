"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fileDigest } = require("./mediaEvidenceFiles");

function decoderIdentity(command) {
  const candidates = command.includes(path.sep) ? [command]
    : (process.env.PATH || "").split(path.delimiter).map(directory => path.join(directory, command));
  const executable = candidates.find(candidate => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  if (!executable) throw new Error("Cannot resolve the audio decoder executable");
  const resolved = fs.realpathSync(executable), executableIdentity = fileDigest(resolved);
  const wrapperReceipt = `${resolved}.decoder.json`;
  let native = null;
  if (fs.existsSync(wrapperReceipt)) {
    const receipt = JSON.parse(fs.readFileSync(wrapperReceipt, "utf8"));
    if (receipt.wrapper_sha256 !== executableIdentity.sha256) throw new Error("FFmpeg wrapper changed after attestation");
    const digest = fileDigest(receipt.native_executable);
    native = { executable: receipt.native_executable, sha256: digest.sha256, bytes: digest.bytes };
  } else {
    const fd = fs.openSync(resolved, "r"), magic = Buffer.alloc(4);
    try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
    if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error("Unattested non-native FFmpeg launcher");
  }
  const version = spawnSync(command, ["-version"], { encoding: "utf8", timeout: 30000, maxBuffer: 50 * 1024 * 1024 });
  if (version.error || version.status !== 0 || !version.stdout) throw new Error("Cannot identify the audio decoder");
  return { executable: resolved, sha256: executableIdentity.sha256, bytes: executableIdentity.bytes, native, version: version.stdout };
}

module.exports = { decoderIdentity };
