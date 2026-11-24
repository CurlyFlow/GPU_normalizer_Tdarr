"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { Worker } = require("node:worker_threads");
const { fileStamp, fileDigest } = require("./mediaDigestCore");
require("./mediaDigestWorker");

const WORKER_DIGEST_MIN_BYTES = 8 * 1024 * 1024;

function fileDigestInWorker(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "mediaDigestWorker.js"), { workerData: { file } });
    let settled = false;
    worker.once("message", (digest) => { settled = true; resolve(digest); });
    worker.once("error", (err) => { if (!settled) { settled = true; reject(err); } });
    worker.once("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Digest worker exited unexpectedly with code ${code}`));
      }
    });
  });
}

async function fileDigestAsync(file) {
  const probe = await fs.promises.stat(file, { bigint: true });
  if (!probe.isFile()) throw new Error("Evidence input is not a regular file");
  if (probe.size >= BigInt(WORKER_DIGEST_MIN_BYTES)) {
    return await fileDigestInWorker(file);
  }
  const handle = await fs.promises.open(file, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('Evidence input is not a regular file');
    const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    const [afterFd, afterPath] = await Promise.all([handle.stat({ bigint: true }), fs.promises.stat(file, { bigint: true })]);
    if (fileStamp(before) !== fileStamp(afterFd) || fileStamp(before) !== fileStamp(afterPath) || BigInt(bytes) !== before.size) {
      throw new Error('Evidence input changed during hashing');
    }
    return { sha256: hash.digest('hex'), bytes, stamp: fileStamp(before) };
  } finally {
    await handle.close();
  }
}

function* readEvidenceLines(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= 0 || size > 4 * 1024 * 1024 * 1024) throw new Error('Packet evidence is empty or exceeds4GiB');
    const buffer = Buffer.allocUnsafe(64 * 1024), decoder = new StringDecoder('utf8');
    let pending = '', bytes = 0, read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      bytes += read;
      if (bytes > size) throw new Error('Packet evidence changed while reading');
      pending += decoder.write(buffer.subarray(0, read));
      let start = 0, newline;
      while ((newline = pending.indexOf('\n', start)) >= 0) {
        if (newline - start > 64 * 1024) throw new Error('Packet evidence line exceeds64KiB');
        yield pending.slice(start, newline).replace(/\r$/, '');
        start = newline + 1;
      }
      if (start > 0) pending = pending.slice(start);
      if (pending.length > 64 * 1024) throw new Error('Packet evidence line exceeds64KiB');
    }
    pending += decoder.end();
    if (bytes !== size) throw new Error('Incomplete packet evidence read');
    if (pending) yield pending.replace(/\r$/, '');
  } finally {
    fs.closeSync(fd);
  }
}

function sameFileGeneration(expected, actual, renamed = false) {
  return typeof expected?.stamp === "string" && typeof actual?.stamp === "string"
    && /^\d+:\d+:\d+:-?\d+:-?\d+$/.test(expected.stamp) && /^\d+:\d+:\d+:-?\d+:-?\d+$/.test(actual.stamp)
    && expected.bytes === actual.bytes && expected.sha256 === actual.sha256
    && (renamed ? expected.stamp.split(":").slice(0, 4).join(":") === actual.stamp.split(":").slice(0, 4).join(":")
      : expected.stamp === actual.stamp);
}

function retainedReceipt(value) {
  const file = value?.receiptPath;
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.geteuid()
      || (info.mode & 0o077) || info.size > 4 * 1024 * 1024 || fs.realpathSync(file) !== file
      || JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) !== JSON.stringify(value)) {
    throw Error("Media receipt differs from its private retained evidence");
  }
  return { file, identity: fileDigest(file) };
}

function writePrivateReceipt(root, prefix, value) {
  if (!/^[a-z-]+$/.test(prefix) || fs.realpathSync(root) !== root) throw Error("Invalid private evidence location");
  const directory = fs.mkdtempSync(path.join(root, `.${prefix}-`));
  const receipt = { ...value, receiptPath: path.join(directory, "receipt.json") };
  const fd = fs.openSync(receipt.receiptPath, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(receipt)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  for (const parent of [directory, root]) {
    const descriptor = fs.openSync(parent, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  }
  return receipt;
}

function readRetainedReceipt(binding) {
  if (!binding || Object.keys(binding).sort().join() !== "file,identity"
      || !sameFileGeneration(binding.identity, fileDigest(binding.file))) throw Error("Retained receipt generation changed");
  const info = fs.lstatSync(binding.file);
  if (info.size > 4 * 1024 * 1024) throw Error("Retained receipt exceeds its bound");
  const value = JSON.parse(fs.readFileSync(binding.file, "utf8"));
  const actual = retainedReceipt(value);
  if (actual.file !== binding.file || !sameFileGeneration(binding.identity, actual.identity)) {
    throw Error("Retained receipt changed while reading");
  }
  return value;
}

module.exports = { fileStamp, fileDigest, fileDigestAsync, readEvidenceLines, sameFileGeneration, retainedReceipt, writePrivateReceipt, readRetainedReceipt };
