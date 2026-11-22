"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");

function fileStamp(stat) {
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs"].map(key => String(stat[key])).join(":");
}

function fileDigest(file) {
  const fd = fs.openSync(file, "r");
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error("Evidence input is not a regular file");
    const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let bytes = 0, read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
    if (fileStamp(before) !== fileStamp(fs.fstatSync(fd, { bigint: true }))
        || fileStamp(before) !== fileStamp(fs.statSync(file, { bigint: true })) || BigInt(bytes) !== before.size) {
      throw new Error("Evidence input changed during hashing");
    }
    return { sha256: hash.digest("hex"), bytes, stamp: fileStamp(before) };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { fileStamp, fileDigest };
