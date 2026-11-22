"use strict";

const assert = require('node:assert/strict');
const { movieTracks, declaredPresentationEnd } = require('./mediaMovieTracks');
const { withMovie } = require('./mediaMovieFile');
const { inspectRuns } = require('./mediaFragmentRuns');
const { clockPlanRequiresFragments } = require('./audioClockPlan');

function indexTargets(reader, top, tracks) {
  const { one, children, read, full } = reader;
  const fragments = new Map(top.filter(box => box.type === 'moof').map(box => [String(box.offset), box]));
  assert.ok(fragments.size > 0, 'This proof requires a fragmented movie');
  const mfra = one(top, 'mfra'), boxes = children(mfra), targets = new Map(), indexed = new Set();
  assert.equal(mfra.end, reader.size, 'Random access index is not terminal');
  const mfro = one(boxes, 'mfro');
  assert.deepEqual(full(mfro), { version: 0, flags: 0 });
  assert.equal(mfro.end - mfro.start, 8);
  assert.equal(read(mfro, mfro.start + 4, 4), BigInt(mfra.end - mfra.offset), 'Wrong random access footer size');
  for (const box of boxes.filter(item => item.type === 'tfra')) {
    const info = full(box), track = String(read(box, box.start + 4, 4));
    assert.equal(info.flags, 0);
    assert.ok(tracks.has(track) && !indexed.has(track), 'Foreign or duplicate indexed track');
    indexed.add(track);
    const lengths = Number(read(box, box.start + 8, 4));
    assert.equal(lengths >>> 6, 0, 'Nonzero random access reserved bits');
    const widths = [(lengths >> 4 & 3) + 1, (lengths >> 2 & 3) + 1, (lengths & 3) + 1];
    const count = Number(read(box, box.start + 12, 4)), width = info.version ? 8 : 4;
    assert.ok(count > 0 && count <= 100000 && box.start + 16 + count * (2 * width + widths.reduce((a, b) => a + b)) === box.end,
      'Invalid random access entry extent');
    let cursor = box.start + 16, previous = -1n;
    for (let index = 0; index < count; index++) {
      const time = read(box, cursor, width), offset = read(box, cursor + width, width); cursor += 2 * width;
      assert.ok(time >= previous, 'Unordered random access times'); previous = time;
      assert.ok(fragments.has(String(offset)), `Random access offset does not locate a moof (track ${track})`);
      const numbers = widths.map(length => { const value = read(box, cursor, length); cursor += length; return String(value); });
      assert.ok(numbers.every(value => BigInt(value) > 0n), 'Invalid random access sample coordinate');
      const key = [offset, ...numbers].join(':');
      assert.ok(!targets.has(key), 'Duplicate random access target');
      targets.set(key, { track, time, coordinate: key, visited: false });
    }
  }
  assert.equal(indexed.size, tracks.size, 'Missing track random access coverage');
  return targets;
}

function fragmentTracks(reader, top) {
  const { one, children, read, full } = reader;
  const { moov, tracks } = movieTracks(reader, top), mvex = children(one(moov, 'mvex'));
  for (const track of tracks.values()) {
    const stts = one(track.table, 'stts');
    assert.equal(read(stts, stts.start + 4, 4), 0n, 'Initial samples require a separate classic-table proof');
    const trex = mvex.find(item => item.type === 'trex' && String(read(item, item.start + 4, 4)) === track.id);
    assert.ok(trex, 'Missing track fragment defaults');
    assert.deepEqual(full(trex), { version: 0, flags: 0 });
    assert.equal(trex.end - trex.start, 24);
    Object.assign(track, { duration: read(trex, trex.start + 12, 4), size: read(trex, trex.start + 16, 4),
      flags: read(trex, trex.start + 20, 4), samples: 0, fragments: 0, seekableFragments: 0, indexed: 0 });
  }
  assert.ok(tracks.size > 0 && tracks.size <= 256 && mvex.filter(box => box.type === 'trex').length === tracks.size);
  return tracks;
}

function inspectFragmentIndex(file) {
  return withMovie(file, (reader, top) => {
    const tracks = fragmentTracks(reader, top), targets = indexTargets(reader, top, tracks);
    inspectRuns(reader, top, tracks, targets);
    return { scope: 'fragment index locations and sync-sample coverage only, not presentation/client acceptance', status: 'pass',
      tracks: [...tracks.values()].map(track => ({ id: track.id, kind: track.kind, rate: String(track.rate),
        mediaTime: String(track.mediaTime), presentationShift: String(track.presentationShift), samples: track.samples,
        first: Object.fromEntries(Object.entries(track.first).map(([key, value]) => [key, String(value)])),
        last: Object.fromEntries(Object.entries(track.last).map(([key, value]) => [key, String(value)])),
        presentationEnd: String(track.last.pts + track.last.duration + track.presentationShift),
        maxPresentationEnd: String(track.maxEnd + track.presentationShift),
        declaredEnd: declaredPresentationEnd(track, track.maxEnd + track.presentationShift),
        fragments: track.fragments, seekableFragments: track.seekableFragments, indexed: track.indexed, durationRuns: track.durationRuns })) };
  });
}

function validateFragmentCoverage(index, plans, videoCount) {
  if (!plans.some(clockPlanRequiresFragments)) {
    assert.equal(index, null, 'Classic transport requires its explicit classic-table result');
    return;
  }
  assert.ok(index?.status === 'pass' && Array.isArray(index.tracks)
    && index.tracks.length > 0 && index.tracks.length <= 256, 'Missing fragment index coverage');
  assert.equal(new Set(index.tracks.map(track => track.id)).size, index.tracks.length, 'Duplicate indexed track');
  for (const track of index.tracks) {
    assert.match(track.id, /^[1-9]\d*$/);
    assert.ok(Number.isSafeInteger(track.samples) && track.samples > 0
      && Number.isSafeInteger(track.fragments) && track.fragments > 0
      && Number.isSafeInteger(track.seekableFragments) && track.seekableFragments > 0
      && track.seekableFragments <= track.fragments && track.indexed === track.seekableFragments,
    'Incomplete seekable fragment coverage');
  }
  assert.equal(index.tracks.filter(track => track.kind === 'vide').length, videoCount, 'Incomplete indexed video coverage');
  assert.equal(index.tracks.filter(track => track.kind === 'soun').length, plans.length, 'Incomplete indexed audio coverage');
  for (const item of plans) {
    const track = index.tracks.find(track => track.id === String(item.streamIndex + 1));
    assert.ok(track?.kind === 'soun' && track.rate === String(item.plan.rate)
      && track.indexed === track.fragments, 'Wrong mapped audio index coverage');
  }
}

module.exports = { inspectFragmentIndex, validateFragmentCoverage };
