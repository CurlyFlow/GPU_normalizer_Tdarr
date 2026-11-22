"use strict";

const assert = require('node:assert/strict');

function movieTracks(reader, top) {
  const { one, children, read, full, bytes } = reader, tracks = new Map();
  const moov = children(one(top, 'moov')), mvhd = one(moov, 'mvhd');
  const movieScale = read(mvhd, mvhd.start + (full(mvhd).version ? 20 : 12), 4);
  assert.ok(movieScale > 0n, 'Invalid movie timescale');
  for (const box of moov.filter(item => item.type === 'trak')) {
    const trak = children(box), tkhd = one(trak, 'tkhd');
    const id = String(read(tkhd, tkhd.start + (full(tkhd).version ? 20 : 12), 4));
    assert.ok(BigInt(id) > 0n && !tracks.has(id), 'Duplicate or invalid movie track');
    const media = children(one(trak, 'mdia')), mdhd = one(media, 'mdhd'), handler = one(media, 'hdlr');
    const rate = read(mdhd, mdhd.start + (full(mdhd).version ? 20 : 12), 4);
    assert.ok(rate > 0n, 'Invalid media timescale');
    const kind = bytes(handler.start + 8, 4).toString('ascii');
    const table = children(one(children(one(media, 'minf')), 'stbl')), edts = one(trak, 'edts', true);
    let offset = 0n, mediaTime = 0n, editDuration = null;
    if (edts) {
      const edit = one(children(edts), 'elst'), info = full(edit), version = info.version;
      assert.equal(info.flags, 0, 'Unsupported edit-list flags');
      const count = Number(read(edit, edit.start + 4, 4)), width = version ? 8 : 4;
      assert.ok((count === 1 || count === 2) && edit.start + 8 + count * (2 * width + 4) === edit.end,
        'Unsupported edit-list presentation mapping');
      let cursor = edit.start + 8;
      for (let index = 0; index < count; index++) {
        const duration = read(edit, cursor, width), time = read(edit, cursor + width, width, true);
        assert.equal(read(edit, cursor + 2 * width, 4), 65536n, 'Non-unit edit rate');
        if (index === count - 1) {
          assert.ok(time >= 0n, 'Missing media edit'); mediaTime = time; editDuration = duration;
        } else {
          assert.equal(time, -1n, 'Unsupported multi-edit media mapping');
          const ticks = duration * rate;
          assert.equal(ticks % movieScale, 0n, 'Fractional empty edit is not admitted'); offset = ticks / movieScale;
        }
        cursor += 2 * width + 4;
      }
    }
    if (kind === 'soun' && editDuration === 0n) {
      assert.ok(top.some(item => item.type === 'moof'), 'Unbounded audio edit in a non-fragmented movie');
    }
    tracks.set(id, { id, rate, kind, table, mediaTime, presentationShift: offset - mediaTime,
      declaredEnd: editDuration === null || editDuration === 0n ? null
        : { numerator: offset * movieScale + editDuration * rate, denominator: rate * movieScale } });
  }
  assert.ok(tracks.size > 0 && tracks.size <= 256);
  return { movieScale, moov, tracks };
}

function declaredPresentationEnd(track, packetEnd) {
  const time = track.declaredEnd ?? { numerator: packetEnd, denominator: track.rate };
  return { numerator: String(time.numerator), denominator: String(time.denominator) };
}

module.exports = { movieTracks, declaredPresentationEnd };
