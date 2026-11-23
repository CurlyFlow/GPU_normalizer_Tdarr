"use strict";

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { isoBoxes } = require('./mediaIsoBoxes');
const { fileDigest, fileStamp } = require('./mediaEvidenceFiles');

function withMovie(file, inspect) {
  assert.equal(fs.realpathSync(file), file, 'Movie path is not canonical');
  const before = fileDigest(file), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    assert.equal(fileStamp(fs.fstatSync(fd, { bigint: true })), before.stamp, 'Movie changed before inspection');
    let cached = Buffer.alloc(0), page = -1;
    const reader = isoBoxes((offset, length) => {
      const start = Math.floor(offset / 65536) * 65536;
      if (offset + length <= start + 65536) {
        if (page !== start) {
          cached = Buffer.alloc(Math.min(65536, before.bytes - start));
          assert.equal(fs.readSync(fd, cached, 0, cached.length, start), cached.length); page = start;
        }
        return cached.subarray(offset - start, offset - start + length);
      }
      const value = Buffer.alloc(length); assert.equal(fs.readSync(fd, value, 0, length, offset), length); return value;
    }, before.bytes);
    const result = inspect(reader, reader.boxes(0, reader.size));
    assert.equal(fileStamp(fs.fstatSync(fd, { bigint: true })), before.stamp, 'Open movie changed during inspection');
    assert.deepEqual(fileDigest(file), before, 'Movie changed during inspection');
    return result;
  } finally { fs.closeSync(fd); }
}

module.exports = { withMovie };
