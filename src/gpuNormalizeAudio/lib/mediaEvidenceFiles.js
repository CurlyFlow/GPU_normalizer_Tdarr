"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

function fileStamp(stat) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key])).join(':');
}

function fileDigest(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error('Evidence input is not a regular file');
    const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0, read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
    if (fileStamp(before) !== fileStamp(fs.fstatSync(fd, { bigint: true }))
        || fileStamp(before) !== fileStamp(fs.statSync(file, { bigint: true })) || BigInt(bytes) !== before.size) {
      throw new Error('Evidence input changed during hashing');
    }
    return { sha256: hash.digest('hex'), bytes, stamp: fileStamp(before) };
  } finally {
    fs.closeSync(fd);
  }
}

function* readEvidenceLines(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= 0 || size > 512 * 1024 * 1024) throw new Error('Packet evidence is empty or exceeds512MiB');
    const buffer = Buffer.allocUnsafe(64 * 1024), decoder = new StringDecoder('utf8');
    let pending = '', bytes = 0, read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      bytes += read;
      if (bytes > size) throw new Error('Packet evidence changed while reading');
      pending += decoder.write(buffer.subarray(0, read));
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        if (newline > 64 * 1024) throw new Error('Packet evidence line exceeds64KiB');
        yield pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
      }
      if (pending.length > 64 * 1024) throw new Error('Packet evidence line exceeds64KiB');
    }
    pending += decoder.end();
    if (bytes !== size) throw new Error('Incomplete packet evidence read');
    if (pending) yield pending;
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

module.exports = { fileStamp, fileDigest, readEvidenceLines, sameFileGeneration, retainedReceipt, writePrivateReceipt, readRetainedReceipt };
