"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fileDigest, fileStamp } = require("./mediaEvidenceFiles");
const { decoderIdentity } = require("./mediaEvidenceTools");

function snapshotCarrier(directory) {
  const source = path.resolve(__dirname, "../runtime/bin/audio_clock_mux");
  assert.equal(fs.realpathSync(source), source, "Carrier artifact is not canonical");
  const info = fs.lstatSync(source);
  assert.ok(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= 32 * 1024 * 1024, "Invalid carrier artifact");
  const before = fileDigest(source), input = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const target = path.join(directory, "audio_clock_mux");
  let output;
  try {
    assert.equal(fileStamp(fs.fstatSync(input, { bigint: true })), before.stamp, "Carrier changed before snapshot");
    output = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const buffer = Buffer.alloc(65536);
    let position = 0;
    while (position < before.bytes) {
      const length = fs.readSync(input, buffer, 0, Math.min(buffer.length, before.bytes - position), position);
      assert.ok(length > 0, "Carrier was truncated during snapshot");
      let written = 0;
      while (written < length) {
        const count = fs.writeSync(output, buffer, written, length - written);
        assert.ok(count > 0, "Carrier snapshot write made no progress"); written += count;
      }
      position += length;
    }
    assert.equal(fs.readSync(input, buffer, 0, 1, position), 0, "Carrier grew during snapshot");
    assert.equal(fileStamp(fs.fstatSync(input, { bigint: true })), before.stamp, "Carrier changed during snapshot");
    fs.fsyncSync(output); fs.fchmodSync(output, 0o500);
  } finally { fs.closeSync(input); if (output !== undefined) fs.closeSync(output); }
  assert.deepEqual(fileDigest(source), before, "Installed carrier changed during snapshot");
  const snapshot = fileDigest(target);
  assert.equal(snapshot.bytes, before.bytes); assert.equal(snapshot.sha256, before.sha256);
  const version = decoderIdentity(target).version;
  assert.match(version, /^audio-clock-mux\.v1 libavformat=3999588 libavcodec=4002661 libavutil=3876708 decoders=0 encoders=0\n$/);
  return { installed: { file: source, identity: before }, snapshot: { file: target, identity: snapshot }, version };
}

function executeCarrier(carrier, argumentsList) {
  const result = spawnSync(carrier.snapshot.file, argumentsList,
    { encoding: "utf8", timeout: 900000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0 || result.stderr || result.stdout) {
    const detail = String(result.stderr || result.error?.message || result.stdout || "").trim().split(/\r?\n/)[0]?.slice(0, 240);
    throw Error(detail ? `Source-built audio clock transport failed: ${detail}` : "Source-built audio clock transport failed");
  }
  const installedNow = fileDigest(carrier.installed.file);
  assert.equal(installedNow.sha256, carrier.installed.identity.sha256, "Installed carrier changed during transport");
  assert.equal(installedNow.bytes, carrier.installed.identity.bytes, "Installed carrier changed during transport");
  assert.deepEqual(fileDigest(carrier.snapshot.file), carrier.snapshot.identity, "Private carrier changed during transport");
}

function runCarrier(carrier, input, output, plan) { executeCarrier(carrier, [input, output, plan]); }
function runPreservingCarrier(carrier, source, template, output, plan) {
  executeCarrier(carrier, ["--preserve-audio", source, template, output, plan]);
}

module.exports = { snapshotCarrier, runCarrier, runPreservingCarrier };
