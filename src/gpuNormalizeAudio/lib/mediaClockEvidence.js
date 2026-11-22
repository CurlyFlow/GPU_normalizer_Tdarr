"use strict";

const assert = require('node:assert/strict');

function* packetRows(lines) {
  let count = 0;
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const row = line.split(',').map(field => field.trim());
    assert.ok(row.length >= 6, 'Invalid packet evidence');
    if (row.length > 6) {
      const sideData = row[6].match(/^S=([1-9]\d*)$/);
      assert.ok(sideData && Number(sideData[1]) <= 64 && row.length === 7 + Number(sideData[1]) * 2,
        'Invalid packet side-data evidence');
      for (let index = 7; index < row.length; index += 2) {
        assert.match(row[index], /^[1-9]\d*$/);
        assert.match(row[index + 1], /^[a-f0-9]{64}$/);
      }
    }
    for (const field of row.slice(0, 5)) assert.match(field, /^-?\d+$/);
    count++;
    yield row;
  }
  assert.ok(count > 0, 'Missing packet evidence');
}

function packetEvidence(lines) {
  const iterator = lines[Symbol.iterator](), headers = [];
  let first;
  while (!(first = iterator.next()).done) {
    if (!first.value) continue;
    if (!first.value.startsWith('#')) break;
    headers.push(first.value);
  }
  const match = headers.join('\n').match(/^#tb 0:\s*(\d+)\/(\d+)$/m);
  assert.ok(match && BigInt(match[1]) > 0n && BigInt(match[2]) > 0n, 'Invalid time base');
  function* remaining() {
    try {
      if (!first.done) yield first.value;
      let next;
      while (!(next = iterator.next()).done) yield next.value;
    } finally {
      iterator.return?.();
    }
  }
  return { headers: headers.filter(line => !line.startsWith('#tb ')),
    base: { numerator: BigInt(match[1]), denominator: BigInt(match[2]) }, rows: packetRows(remaining()) };
}

function sameTime(left, right) {
  return left.numerator * right.denominator === right.numerator * left.denominator;
}

function subtract(left, right) {
  return { numerator: left.numerator * right.denominator - right.numerator * left.denominator,
    denominator: left.denominator * right.denominator };
}

function packetTime(value, base) {
  return { numerator: BigInt(value) * base.numerator, denominator: base.denominator };
}

function headersMatch(beforeHeaders, afterHeaders, allowEquivalentExtradata) {
  if (beforeHeaders.length === afterHeaders.length
      && beforeHeaders.every((line, index) => line === afterHeaders[index])) return true;
  if (!allowEquivalentExtradata || beforeHeaders.length !== afterHeaders.length) return false;
  let extradataDiffs = 0;
  for (let index = 0; index < beforeHeaders.length; index++) {
    if (beforeHeaders[index] === afterHeaders[index]) continue;
    if (beforeHeaders[index].startsWith('#extradata ') && afterHeaders[index].startsWith('#extradata ')) {
      extradataDiffs += 1;
      continue;
    }
    return false;
  }
  return extradataDiffs === 1 && allowEquivalentExtradata() === true;
}

function videoShift(source, output, comparePixels, options = {}) {
  try {
    const before = packetEvidence(source), after = packetEvidence(output);
    if (!headersMatch(before.headers, after.headers, options.allowEquivalentExtradata)) {
      assert.deepEqual(after.headers, before.headers, 'Video configuration changed');
    }
    let offset, pendingDur = null;
    const matroskaTransformed = !comparePixels
      && before.base.numerator === 1n && before.base.denominator === 1000n
      && after.base.numerator === 1n && after.base.denominator === 1000n;
    while (true) {
      const left = before.rows.next(), right = after.rows.next();
      assert.equal(right.done, left.done, 'Video packet count changed');
      if (left.done) break;
      const prior = left.value, next = right.value;
      if (pendingDur) {
        assert.equal(BigInt(next[2]), pendingDur.expectedNextPts, 'Video packet duration changed');
        pendingDur = null;
      }
      offset ??= subtract(packetTime(next[1], after.base), packetTime(prior[1], before.base));
      assert.equal(next[0], prior[0]);
      assert.equal(next[4], prior[4], 'Video packet/frame size changed');
      if (comparePixels) assert.deepEqual(next.slice(5), prior.slice(5), 'Video packet payload changed');
      const sameDur = sameTime(packetTime(next[3], after.base), packetTime(prior[3], before.base));
      if (!sameDur) {
        assert.ok(matroskaTransformed && BigInt(next[3]) > 0n, 'Video packet duration changed');
        pendingDur = { expectedNextPts: BigInt(next[2]) + BigInt(next[3]), priorDur: BigInt(prior[3]), nextDur: BigInt(next[3]) };
      }
      for (const field of [1, 2]) {
        assert.ok(sameTime(subtract(packetTime(next[field], after.base), packetTime(prior[field], before.base)), offset),
          'Video DTS/PTS drift');
      }
    }
    if (pendingDur) {
      assert.ok(pendingDur.nextDur - pendingDur.priorDur === 1n || pendingDur.priorDur - pendingDur.nextDur === 1n,
        'Video packet duration changed');
    }
    return offset;
  } finally {
    source.return?.();
    output.return?.();
  }
}

function copiedVideoShift(source, output, options = {}) {
  return videoShift(source, output, true, options);
}

// Only for an explicitly permitted lossy transform. Independent reference pixels
// are checked separately; source frame count/order and rational clocks still match.
function transformedVideoShift(source, output) {
  return videoShift(source, output, false);
}

// Fast packet-copy timeline verification for NVENC-transcoded video without
// full software rawvideo decoding or a duplicate reference encode.
function transformedPacketShift(source, output) {
  try {
    const before = packetEvidence(source), after = packetEvidence(output);
    const collectPts = (evidence) => {
      const pts = [];
      for (const row of evidence.rows) pts.push(BigInt(row[2]));
      pts.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return pts;
    };
    const beforePts = collectPts(before), afterPts = collectPts(after);
    assert.equal(afterPts.length, beforePts.length, 'Video packet count changed');
    let offset = null;
    for (let index = 0; index < beforePts.length; index++) {
      const shift = subtract(packetTime(afterPts[index], after.base), packetTime(beforePts[index], before.base));
      offset ??= shift;
      assert.ok(sameTime(shift, offset), 'Video PTS drift');
    }
    return offset;
  } finally {
    source.return?.();
    output.return?.();
  }
}

function copiedVideoOffset(source, output) {
  const shift = copiedVideoShift(source.split('\n'), output.split('\n'));
  return Number(shift.numerator) / Number(shift.denominator);
}

// Encoded payload proof only. Presentation/decode clocks and valid windows are
// independent obligations; deliberately changed timestamps cannot pass those here.
function comparePacketPayloads(source, output) {
  try {
    const before = packetEvidence(source), after = packetEvidence(output);
    let packets = 0;
    while (true) {
      const left = before.rows.next(), right = after.rows.next();
      assert.equal(right.done, left.done, 'Encoded packet count changed');
      if (left.done) break;
      assert.equal(right.value[0], left.value[0], 'Encoded stream changed');
      assert.deepEqual(right.value.slice(4), left.value.slice(4), 'Encoded packet payload changed');
      packets++;
    }
    return { packets };
  } finally {
    source.return?.();
    output.return?.();
  }
}

function decodedAudioTimeline(frames, rate, tick = null) {
  assert.ok(Number.isSafeInteger(rate) && rate > 0, 'Invalid native audio rate');
  const coarseTick = tick && typeof tick.numerator === 'bigint' && typeof tick.denominator === 'bigint'
    && tick.numerator > 0n && tick.denominator > 0n
    && tick.numerator * BigInt(rate) > tick.denominator ? tick : null;
  const segments = [];
  let samples = 0n;
  let previousEnd = null;
  for (const { start, frameSamples } of frames) {
    assert.ok(typeof frameSamples === 'bigint' && frameSamples > 0n, 'Invalid decoded audio frame size');
    assert.ok(typeof start.numerator === 'bigint' && typeof start.denominator === 'bigint'
      && start.denominator > 0n, 'Invalid native audio PTS');
    let continuous = false;
    if (previousEnd !== null) {
      if (!coarseTick) {
        continuous = sameTime(start, previousEnd);
      } else {
        const delta = subtract(start, previousEnd);
        const absNum = delta.numerator < 0n ? -delta.numerator : delta.numerator;
        // Coarse container timebases (e.g. Matroska 1/1000s) quantize frame PTS
        // onto `coarseTick` and may step by 1 tick for PAL/NTSC sync while real
        // drops/cuts/overlaps (> 2 ticks) remain discontinuities.
        continuous = absNum * coarseTick.denominator <= 2n * coarseTick.numerator * delta.denominator;
      }
    }
    if (!continuous) {
      assert.ok(segments.length < 100000, 'Too many audio discontinuities');
      segments.push({ samples, start });
    }
    previousEnd = { numerator: start.numerator * BigInt(rate) + frameSamples * start.denominator,
      denominator: start.denominator * BigInt(rate) };
    samples += frameSamples;
  }
  assert.ok(samples > 0n, 'Missing decoded audio frames');
  return coarseTick ? { samples, segments, rate, coarseTick } : { samples, segments, rate };
}

function audioTimeline(lines, channels, rate, sampleBytes) {
  assert.ok(Number.isSafeInteger(channels) && channels > 0 && Number.isSafeInteger(rate) && rate > 0);
  assert.ok(sampleBytes === 4 || sampleBytes === 8, 'Invalid comparison sample width');
  const { base, rows } = packetEvidence(lines);
  function* frames() {
    for (const row of rows) {
      assert.equal(row[0], '0', 'Unexpected audio stream');
      assert.equal(row[1], row[2], 'Decoded audio DTS differs from PTS');
      const width = BigInt(sampleBytes) * BigInt(channels);
      const bytes = BigInt(row[4]), frameSamples = bytes / width;
      assert.ok(frameSamples > 0n && frameSamples * width === bytes, 'Invalid decoded PCM frame size');
      assert.ok(sameTime(packetTime(row[3], base), { numerator: frameSamples, denominator: BigInt(rate) }),
        'Decoded audio sample duration changed');
      yield { start: packetTime(row[2], base), frameSamples };
    }
  }
  return decodedAudioTimeline(frames(), rate);
}

function compareAudioTimelines(before, after, offset, expectedDecodedSamples = null) {
    const firstShift = subtract(after.segments[0].start, before.segments[0].start);
    assert.ok(sameTime(firstShift, offset),
      `Audio timeline changed relative to video at first sample: ${firstShift.numerator}/${firstShift.denominator}s, expected ${offset.numerator}/${offset.denominator}s`);
    if (expectedDecodedSamples === null) {
      assert.ok(sameTime({ numerator: after.samples, denominator: BigInt(after.rate) },
        { numerator: before.samples, denominator: BigInt(before.rate) }),
      `Decoded audio timeline duration changed: original=${before.samples}/${before.rate}s candidate=${after.samples}/${after.rate}s`);
    } else {
      assert.equal(after.samples, expectedDecodedSamples,
        `Normalized audio decoded samples differ: expected=${expectedDecodedSamples} candidate=${after.samples}`);
    }
    const describe = timeline => JSON.stringify(timeline.segments.slice(0, 8).map(segment => ({
      sample: String(segment.samples), rate: timeline.rate,
      pts: `${segment.start.numerator}/${segment.start.denominator}`,
    })));
    assert.equal(after.segments.length, before.segments.length,
      `Audio discontinuity count changed; original=${describe(before)} candidate=${describe(after)}`);
    const coarseTick = before.coarseTick || after.coarseTick || null;
    const sameWithinTick = (left, right) => {
      if (sameTime(left, right)) return true;
      if (!coarseTick) return false;
      const delta = subtract(left, right);
      const absNum = delta.numerator < 0n ? -delta.numerator : delta.numerator;
      return absNum * coarseTick.denominator <= coarseTick.numerator * delta.denominator;
    };
    for (let index = 1; index < before.segments.length; index++) {
      assert.ok(sameTime({ numerator: after.segments[index].samples, denominator: BigInt(after.rate) },
        { numerator: before.segments[index].samples, denominator: BigInt(before.rate) }), 'Audio gap moved within content');
      const shift = subtract(after.segments[index].start, before.segments[index].start);
      assert.ok(sameWithinTick(shift, offset),
        `Audio timeline changed relative to video at sample ${before.segments[index].samples}: ${shift.numerator}/${shift.denominator}s, expected ${offset.numerator}/${offset.denominator}s`);
    }
    return { samples: String(after.samples), segments: before.segments.length };
}

function compareAudioTimeline(source, output, sourceSpec, outputSpec, offset) {
  try {
    return compareAudioTimelines(audioTimeline(source, sourceSpec.channels, sourceSpec.rate, sourceSpec.sampleBytes),
      audioTimeline(output, outputSpec.channels, outputSpec.rate, outputSpec.sampleBytes), offset);
  } finally {
    source.return?.();
    output.return?.();
  }
}

module.exports = { copiedVideoShift, transformedVideoShift, transformedPacketShift, copiedVideoOffset, compareAudioTimeline,
  decodedAudioTimeline, compareAudioTimelines, comparePacketPayloads };
