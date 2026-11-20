"use strict";

const assert = require('node:assert/strict');
const { withMovie } = require('./mediaMovieFile');
const { movieTracks, declaredPresentationEnd } = require('./mediaMovieTracks');
const { inspectFragmentIndex } = require('./mediaFragmentIndex');

// Stored AAC tables, including admitted non-LC timing runs. This is not a carrier plan.
function inspectStoredAacWindows(file) {
  return withMovie(file, (reader, top) => {
    const { one, read, full, boxes } = reader, result = [];
    for (const track of movieTracks(reader, top).tracks.values()) {
      if (track.kind !== 'soun') continue;
      const stsd = one(track.table, 'stsd');
      assert.deepEqual(full(stsd), { version: 0, flags: 0 });
      assert.equal(read(stsd, stsd.start + 4, 4), 1n, 'Multiple audio descriptions are not admitted');
      one(boxes(stsd.start + 8, stsd.end), 'mp4a');
      const stts = one(track.table, 'stts'), entries = Number(read(stts, stts.start + 4, 4));
      assert.deepEqual(full(stts), { version: 0, flags: 0 });
      assert.ok(entries > 0 && entries <= 100000 && stts.start + 8 + 8 * entries === stts.end, 'Invalid audio duration table');
      let samples = 0n, decode = 0n, firstDuration, lastDuration;
      const durationRuns = [];
      for (let index = 0; index < entries; index++) {
        const cursor = stts.start + 8 + 8 * index, count = read(stts, cursor, 4), duration = read(stts, cursor + 4, 4);
        assert.ok(count > 0n && duration > 0n && (samples += count) <= 10000000n, 'Invalid audio sample duration');
        if (firstDuration === undefined) firstDuration = duration;
        lastDuration = duration; decode += count * duration;
        const previous = durationRuns.at(-1);
        if (previous?.duration === String(duration)) previous.count = String(BigInt(previous.count) + count);
        else durationRuns.push({ count: String(count), duration: String(duration) });
      }
      const ctts = one(track.table, 'ctts', true);
      if (ctts) {
        const info = full(ctts), count = Number(read(ctts, ctts.start + 4, 4));
        assert.ok(count <= 100000 && ctts.start + 8 + count * 8 === ctts.end);
        let covered = 0n;
        for (let index = 0; index < count; index++) {
          const cursor = ctts.start + 8 + index * 8, length = read(ctts, cursor, 4);
          assert.ok(length > 0n); covered += length;
          assert.equal(read(ctts, cursor + 4, 4, info.version === 1), 0n, 'Input AAC is not composition-continuous');
        }
        assert.equal(covered, samples, 'Input composition coverage differs');
      }
      const stsz = one(track.table, 'stsz');
      assert.deepEqual(full(stsz), { version: 0, flags: 0 });
      assert.equal(read(stsz, stsz.start + 8, 4), samples, 'Audio size/duration sample coverage differs');
      assert.equal(stsz.end - stsz.start, read(stsz, stsz.start + 4, 4) ? 12 : 12 + 4 * Number(samples));
      result.push({ id: track.id, kind: track.kind, rate: String(track.rate), samples: String(samples), mediaTime: String(track.mediaTime),
        presentationShift: String(track.presentationShift), first: { pts: '0', duration: String(firstDuration) },
        last: { pts: String(decode - lastDuration), duration: String(lastDuration) },
        presentationEnd: String(decode + track.presentationShift), maxPresentationEnd: String(decode + track.presentationShift),
        declaredEnd: declaredPresentationEnd(track, decode + track.presentationShift), durationRuns });
    }
    assert.ok(result.length > 0, 'Missing AAC sample tables'); return result;
  });
}

// Carrier inputs still require complete LC frames, independent of copy-window checks.
function inspectAudioWindows(file) {
  const tracks = inspectStoredAacWindows(file);
  for (const track of tracks) track.durationRuns.forEach((run, index) => {
    assert.ok(run.duration === '1024' || (index === track.durationRuns.length - 1 && run.count === '1'
      && BigInt(run.duration) <= 1024n), 'Input AAC sample durations are not a complete LC frame sequence');
  });
  return tracks;
}

function validateDeclaredWindow(value) {
  const times = ['input', 'output', 'shift'].map(key => {
    const time = value?.[key];
    assert.ok(time && typeof time.numerator === 'string' && /^-?\d{1,80}$/.test(time.numerator)
      && typeof time.denominator === 'string' && /^[1-9]\d{0,79}$/.test(time.denominator), 'Missing exact declared audio window');
    return { n: BigInt(time.numerator), d: BigInt(time.denominator) };
  });
  const [before, after, shift] = times;
  assert.equal((after.n * before.d - before.n * after.d) * shift.d,
    shift.n * before.d * after.d, 'Declared audio presentation window changed');
}

function compareDeclaredWindows(before, after, shift) {
  const declared = { input: before.declaredEnd, output: after.declaredEnd,
    shift: { numerator: String(shift), denominator: before.rate } };
  validateDeclaredWindow(declared);
  return declared;
}

function compareTransportWindows(input, fragments, plans) {
  const output = fragments.tracks.filter(track => track.kind === 'soun');
  assert.equal(input.length, output.length, 'Audio window coverage differs');
  return input.map((before, index) => {
    const after = output[index], plan = plans[index].plan, events = plan.segments;
    assert.equal(before.id, after.id); assert.equal(before.rate, after.rate); assert.equal(Number(before.rate), plan.rate);
    assert.equal(BigInt(before.samples), BigInt(after.samples), 'Encoded sample count changed');
    assert.equal(before.mediaTime, after.mediaTime, 'AAC priming edit changed');
    const initial = BigInt(events[0].pts) - BigInt(plan.inputStart);
    const lastEvent = events.at(-1), tail = BigInt(lastEvent.pts) - BigInt(lastEvent.sample) - BigInt(plan.inputStart);
    assert.equal(BigInt(after.first.pts) + BigInt(after.presentationShift),
      BigInt(before.first.pts) + BigInt(before.presentationShift) + initial, 'First encoded presentation differs');
    assert.equal(after.last.duration, before.last.duration, 'Terminal encoded sample duration changed');
    assert.equal(BigInt(after.presentationEnd), BigInt(before.presentationEnd) + tail, 'Terminal presentation window changed');
    const maximum = events.reduce((end, event, eventIndex) => {
      const boundary = BigInt(events[eventIndex + 1]?.sample ?? plan.samples);
      const duration = eventIndex === events.length - 1 ? BigInt(before.last.duration) : 1024n;
      const actual = BigInt(event.pts) + boundary - BigInt(event.sample) - 1024n + duration;
      return end === null || actual > end ? actual : end;
    }, null);
    assert.equal(BigInt(after.maxPresentationEnd), maximum, 'Maximum presentation window changed');
    const declared = compareDeclaredWindows(before, after, tail);
    return { id: after.id, status: 'pass', declared, inputEnd: before.presentationEnd, outputEnd: after.presentationEnd,
      lastDuration: after.last.duration, priming: after.mediaTime };
  });
}

function movieAudioPresentation(file, inspectWindows) {
  const fragmented = withMovie(file, (_reader, top) => top.some(box => box.type === 'moof'));
  const index = fragmented ? inspectFragmentIndex(file) : null;
  return { tracks: index ? index.tracks.filter(track => track.kind === 'soun') : inspectWindows(file), index };
}

function audioPresentation(file) { return movieAudioPresentation(file, inspectAudioWindows); }
function storedAudioPresentation(file) { return movieAudioPresentation(file, inspectStoredAacWindows); }

function compareWindowTracks(input, output, tracks) {
  assert.equal(input.length, tracks.length); assert.equal(output.length, tracks.length);
  return input.map((before, ordinal) => {
    const after = output[ordinal], track = tracks[ordinal];
    assert.equal(before.id, track.sourceTrackId); assert.equal(after.id, String(track.streamIndex + 1));
    for (const key of ['rate', 'mediaTime']) assert.equal(before[key], after[key], `Preserved audio ${key} changed`);
    assert.equal(BigInt(before.samples), BigInt(after.samples));
    assert.deepEqual(before.durationRuns, after.durationRuns, 'Stored audio duration sequence changed');
    const shift = track.shift;
    assert.equal(BigInt(after.first.pts) + BigInt(after.presentationShift),
      BigInt(before.first.pts) + BigInt(before.presentationShift) + shift, 'Preserved first audio presentation changed');
    for (const key of ['presentationEnd', 'maxPresentationEnd']) {
      assert.equal(BigInt(after[key]), BigInt(before[key]) + shift, `Preserved audio ${key} changed`);
    }
    const declared = compareDeclaredWindows(before, after, shift);
    return { id: after.id, status: 'pass', declared, inputEnd: before.presentationEnd, outputEnd: after.presentationEnd,
      lastDuration: after.last.duration, priming: after.mediaTime };
  });
}

function comparePreservedWindows(input, output, plans) {
  return compareWindowTracks(input, output, plans.map(track => ({ sourceTrackId: track.sourceTrackId,
    streamIndex: track.streamIndex, shift: BigInt(track.plan.segments[0].pts) - BigInt(track.plan.inputStart) })));
}

function compareStageAudioWindows(input, output, streamIndexes, offset) {
  assert.equal(input.length, streamIndexes.length);
  assert.ok(typeof offset.numerator === 'bigint' && typeof offset.denominator === 'bigint' && offset.denominator > 0n);
  return compareWindowTracks(input, output, input.map((track, index) => {
    const ticks = offset.numerator * BigInt(track.rate);
    assert.equal(ticks % offset.denominator, 0n, 'Audio window shift is not exactly representable');
    return { sourceTrackId: track.id, streamIndex: streamIndexes[index], shift: ticks / offset.denominator };
  }));
}

module.exports = { inspectAudioWindows, compareTransportWindows, audioPresentation, comparePreservedWindows,
  storedAudioPresentation, compareStageAudioWindows, validateDeclaredWindow };
