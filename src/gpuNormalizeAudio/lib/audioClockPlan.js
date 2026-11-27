"use strict";

const assert = require("node:assert/strict");

function exactTicks(time, rate) {
  assert.ok(typeof time.numerator === "bigint" && typeof time.denominator === "bigint" && time.denominator > 0n);
  const scaled = time.numerator * BigInt(rate);
  assert.equal(scaled % time.denominator, 0n, "Original clock is not representable at the AAC time base");
  const ticks = scaled / time.denominator;
  assert.ok(ticks > -(1n << 63n) && ticks < (1n << 63n), "AAC clock exceeds int64");
  return ticks;
}

// An AAC-LC packet-copy plan, not an acceptance verdict. Final native clocks,
// complete values and presentation tables must still be verified independently.
function clockSegments(source, rate, offset) {
  assert.ok(Number.isSafeInteger(source.rate) && source.rate > 0);
  assert.ok(Number.isSafeInteger(rate) && rate >= 8000 && rate <= 192000);
  assert.ok(source.samples > 0n && source.segments.length > 0 && source.segments.length <= 100000);
  let previous = -1n, lead = 0n;
  const segments = source.segments.map(segment => {
    assert.ok(typeof segment.samples === "bigint" && segment.samples >= 0n && segment.samples < source.samples);
    const position = segment.samples * BigInt(rate);
    assert.equal(position % BigInt(source.rate), 0n, "Original discontinuity falls between output samples");
    const sample = position / BigInt(source.rate);
    assert.ok(sample > previous && sample % 1024n === 0n, "Original discontinuity is not at an AAC packet boundary");
    previous = sample;
    const pts = exactTicks({ numerator: segment.start.numerator * offset.denominator
      + offset.numerator * segment.start.denominator,
    denominator: segment.start.denominator * offset.denominator }, rate);
    return { sample, pts };
  });
  assert.equal(segments[0].sample, 0n);
  for (const segment of segments) {
    const delta = segment.pts - segments[0].pts - segment.sample;
    if (-delta > lead) lead = -delta;
    assert.ok(delta >= -(segment.sample / 1024n) * 512n,
      "Overlap precedes the priming-preserving decode-lead ramp");
  }
  assert.ok(lead <= 2147483647n, "AAC composition lead exceeds the carrier");
  for (const segment of segments) assert.ok(segment.pts - segments[0].pts - segment.sample + lead <= 2147483647n,
    "AAC composition offset exceeds the carrier");
  return { lead: String(lead), segments: segments.map(segment => ({ sample: String(segment.sample), pts: String(segment.pts) })) };
}

function planAacClock(source, candidate, offset) {
  assert.ok(candidate.samples > 0n && candidate.segments.length === 1,
    "Clock transport requires complete source and continuous encoded-input timelines");
  assert.equal(source.samples * BigInt(candidate.rate), candidate.samples * BigInt(source.rate),
    "Decoded source and encoded input durations differ");
  assert.equal(candidate.samples % 1024n, 0n, "AAC-LC decoded sample coverage is incomplete");
  assert.equal(candidate.segments[0].samples, 0n);
  return { rate: candidate.rate, samples: String(candidate.samples),
    inputStart: String(exactTicks(candidate.segments[0].start, candidate.rate)), ...clockSegments(source, candidate.rate, offset) };
}

function planAacPreservation(source, offset) {
  assert.equal(source.samples % 1024n, 0n, "AAC-LC decoded sample coverage is incomplete");
  return { rate: source.rate, samples: String(source.samples), inputStart: String(exactTicks(source.segments[0].start, source.rate)),
    ...clockSegments(source, source.rate, offset) };
}

function reduceRational(numerator, denominator) {
  assert.ok(typeof numerator === "bigint" && typeof denominator === "bigint" && denominator > 0n);
  let a = numerator < 0n ? -numerator : numerator, b = denominator;
  while (b) { const remainder = a % b; a = b; b = remainder; }
  return { numerator: numerator / a, denominator: denominator / a };
}

function encodedWindow(end) {
  assert.ok(end && typeof end.numerator === "string" && /^-?\d{1,80}$/.test(end.numerator)
    && typeof end.denominator === "string" && /^[1-9]\d{0,79}$/.test(end.denominator), "Missing admitted AAC edit endpoint");
  const { numerator, denominator } = reduceRational(BigInt(end.numerator), BigInt(end.denominator));
  assert.ok(numerator > -(1n << 63n) && numerator < (1n << 63n) && denominator <= 2147483647n,
    "AAC edit endpoint exceeds the exact carrier bounds");
  return `${numerator} ${denominator}`;
}

function rationalSubtractShift(originalEnd, offset, tailTicks, rate) {
  const [origNum, origDen] = encodedWindow(originalEnd).split(" ").map(BigInt);
  assert.ok(typeof offset?.numerator === "bigint" && typeof offset?.denominator === "bigint" && offset.denominator > 0n);
  assert.ok(typeof tailTicks === "bigint" && Number.isSafeInteger(rate) && rate > 0);
  const shiftedNum = origNum * offset.denominator + offset.numerator * origDen;
  const shiftedDen = origDen * offset.denominator;
  const { numerator, denominator } = reduceRational(
    shiftedNum * BigInt(rate) - tailTicks * shiftedDen, shiftedDen * BigInt(rate));
  const result = { numerator: String(numerator), denominator: String(denominator) };
  encodedWindow(result);
  return result;
}

function assertNormalizedAacWindowCounts(candidateWindow, counts, rate) {
  assert.ok(candidateWindow, "Missing candidate AAC presentation window");
  assert.equal(BigInt(candidateWindow.rate), BigInt(rate), "Normalized AAC window rate differs");
  const priming = BigInt(candidateWindow.mediaTime);
  assert.equal(priming, 1024n, "Normalized AAC requires standard 1024-sample priming");
  assert.equal(BigInt(candidateWindow.samples) * 1024n - priming, counts.decodedSamples,
    "Normalized AAC packet count differs from decoded count domain");
  const codedTicks = candidateWindow.durationRuns.reduce(
    (sum, run) => sum + BigInt(run.count) * BigInt(run.duration), 0n);
  assert.equal(codedTicks - priming, counts.validSamples,
    "Normalized AAC raw extent differs from valid count domain");
}

// Derive the carrier plan for an explicitly qualified normalized AAC stream.
// Never weakens strict copied-clock rules; caller must supply verified count
// domain and admitted original presentation endpoint.
function planNormalizedAacClock(source, candidate, offset, { counts, originalEnd, candidateWindow }) {
  assert.ok(candidate.samples > 0n && candidate.segments.length === 1,
    "Clock transport requires complete source and continuous encoded-input timelines");
  assert.equal(candidate.samples, counts.decodedSamples,
    "Normalized AAC decoded sample count differs from exact count domain");
  assert.equal(candidate.samples % 1024n, 0n, "AAC-LC decoded sample coverage is incomplete");
  assert.equal(candidate.segments[0].samples, 0n);
  assertNormalizedAacWindowCounts(candidateWindow, counts, candidate.rate);
  const inputStart = exactTicks(candidate.segments[0].start, candidate.rate);
  const timed = clockSegments(source, candidate.rate, offset);
  const last = timed.segments.at(-1);
  const tail = BigInt(last.pts) - BigInt(last.sample) - inputStart;
  return {
    plan: { rate: candidate.rate, samples: String(candidate.samples), inputStart: String(inputStart), ...timed },
    declaredEnd: rationalSubtractShift(originalEnd, offset, tail, candidate.rate),
  };
}

function clockPlanRequiresFragments({ plan, declaredEnd }) {
  const [numerator, denominator] = encodedWindow(declaredEnd).split(" ").map(BigInt);
  const lastStart = BigInt(plan.inputStart) + BigInt(plan.samples) - 1024n;
  // Reproduce the carrier's representation choice, not a timing acceptance.
  return plan.segments.length > 1 || lastStart * denominator >= numerator * BigInt(plan.rate);
}

function encodeClockPlan(tracks) {
  assert.ok(Array.isArray(tracks) && tracks.length > 0 && tracks.length <= 128);
  let previous = -1;
  const lines = ["audio-clock-plan.v1", String(tracks.length)];
  let totalRows = 0;
  for (const { streamIndex, plan, durationRuns, declaredEnd } of tracks) {
    assert.ok(Number.isSafeInteger(streamIndex) && streamIndex > previous && streamIndex < 256);
    previous = streamIndex;
    lines.push([streamIndex, plan.rate, plan.samples, plan.inputStart, plan.lead, plan.segments.length].join(" "));
    for (const segment of plan.segments) lines.push(`${segment.sample} ${segment.pts}`);
    assert.ok(Array.isArray(durationRuns) && durationRuns.length > 0 && (totalRows += durationRuns.length) <= 100000);
    lines.push(String(durationRuns.length));
    let packets = 0n;
    for (const run of durationRuns) {
      assert.match(run.count, /^[1-9]\d*$/); assert.match(run.duration, /^[1-9]\d*$/);
      packets += BigInt(run.count);
      assert.ok(packets <= 10000000n && BigInt(run.duration) <= 1024n);
      lines.push(`${run.count} ${run.duration}`);
    }
    assert.ok(packets * 1024n === BigInt(plan.samples) || packets * 1024n === BigInt(plan.samples) + 1024n);
    lines.push(encodedWindow(declaredEnd));
  }
  const text = `${lines.join("\n")}\n`;
  assert.ok(Buffer.byteLength(text) <= 8 * 1024 * 1024);
  return text;
}

module.exports = { planAacClock, planAacPreservation, planNormalizedAacClock,
  assertNormalizedAacWindowCounts, rationalSubtractShift, reduceRational, encodeClockPlan, clockPlanRequiresFragments };
