const assert = require('node:assert/strict');

// Metadata-only reader. Media payloads stay in their file; all offsets are bounded.
function isoBoxes(readAt, size, maxBoxes = 1000000) {
  assert.ok(Number.isSafeInteger(size) && size > 0 && Number.isSafeInteger(maxBoxes) && maxBoxes > 0);
  let count = 0;
  const bytes = (offset, length) => {
    assert.ok(Number.isSafeInteger(offset) && Number.isSafeInteger(length)
      && offset >= 0 && length >= 0 && length <= 1024 * 1024 && offset + length <= size, 'Invalid movie read extent');
    const value = readAt(offset, length);
    assert.ok(Buffer.isBuffer(value) && value.length === length, 'Truncated movie read');
    return value;
  };
  const boxes = (start, end) => {
    assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end <= size && start <= end);
    const result = [];
    for (let offset = start; offset < end;) {
      assert.ok(++count <= maxBoxes && end - offset >= 8, 'Invalid or excessive movie boxes');
      const base = bytes(offset, 8);
      let length = BigInt(base.readUInt32BE(0)), header = 8;
      if (length === 1n) {
        assert.ok(end - offset >= 16, 'Truncated extended movie box');
        length = bytes(offset + 8, 8).readBigUInt64BE(); header = 16;
      } else if (length === 0n) length = BigInt(end - offset);
      assert.ok(length >= BigInt(header) && length <= BigInt(end - offset), 'Movie box exceeds its parent');
      const next = offset + Number(length);
      result.push({ type: base.toString('ascii', 4, 8), offset, start: offset + header, end: next });
      offset = next;
    }
    return result;
  };
  const one = (list, type, optional = false) => {
    const found = list.filter(box => box.type === type);
    assert.ok(found.length === 1 || (optional && found.length === 0), `Missing or duplicate ${type}`);
    return found[0];
  };
  const read = (box, offset, width, signed = false) => {
    assert.ok([1, 2, 3, 4, 8].includes(width) && offset >= box.start && offset + width <= box.end, `Truncated ${box.type}`);
    const value = bytes(offset, width);
    if (width === 8) return signed ? value.readBigInt64BE() : value.readBigUInt64BE();
    return BigInt(signed ? value.readIntBE(0, width) : value.readUIntBE(0, width));
  };
  const full = box => {
    const value = read(box, box.start, 4);
    const version = Number(value >> 24n);
    assert.ok(version <= 1, `Unsupported ${box.type} version`);
    return { version, flags: Number(value & 0xffffffn) };
  };
  return { boxes, children: box => boxes(box.start, box.end), one, read, full, bytes, size };
}

module.exports = { isoBoxes };
