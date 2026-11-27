"use strict";

const assert = require("node:assert/strict");

function containingData(mdats, position) {
  let left = 0, right = mdats.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (BigInt(mdats[middle].start) <= position) left = middle + 1;
    else right = middle;
  }
  const box = mdats[left - 1];
  assert.ok(box && position < BigInt(box.end), "Sample escapes media data");
  return box;
}

// Optional ISO fields advance one cursor; absent fields retain their declared defaults.
function fields(reader, box, start, flags) {
  let cursor = start;
  return {
    take(flag, width, fallback, signed = false) {
      if (!(flags & flag)) return fallback;
      const value = reader.read(box, cursor, width, signed); cursor += width;
      return value;
    },
    end() { assert.equal(cursor, box.end, "Invalid fragment field extent"); },
  };
}

function fragmentHeader(reader, moof, trafIndex, box, tracks) {
  const { one, children, read, full } = reader;
  const traf = children(box), tfhd = one(traf, "tfhd"), flags = full(tfhd).flags;
  assert.equal(flags & ~0x02003b, 0, "Unsupported track fragment flags");
  const track = tracks.get(String(read(tfhd, tfhd.start + 4, 4)));
  assert.ok(track, "Unknown fragment track"); track.fragments++;
  const header = fields(reader, tfhd, tfhd.start + 8, flags);
  const base = header.take(1, 8, BigInt(moof.offset));
  assert.ok(flags & 1 || flags & 0x020000 || trafIndex === 0, "Implicit cross-track data base is not admitted");
  assert.equal(header.take(2, 4, 1n), 1n);
  const duration = header.take(8, 4, track.duration), size = header.take(16, 4, track.size);
  const sampleFlags = header.take(32, 4, track.flags); header.end();
  const tfdt = one(traf, "tfdt"), time = full(tfdt);
  const decode = read(tfdt, tfdt.start + 4, time.version ? 8 : 4);
  assert.equal(tfdt.end - tfdt.start, time.version ? 12 : 8);
  const runs = traf.filter(item => item.type === "trun");
  assert.ok(runs.length > 0 && runs.length <= 100000);
  return { track, base, duration, size, sampleFlags, decode, runs };
}

function recordSample(track, targets, coordinate, row, flags, fragmentStart) {
  if (track.kind === "soun") {
    const runs = track.durationRuns ||= [], previous = runs.at(-1);
    if (previous?.duration === String(row.duration)) previous.count = String(BigInt(previous.count) + 1n);
    else {
      assert.ok(runs.length < 100000, "Excessive sample duration runs");
      runs.push({ count: "1", duration: String(row.duration) });
    }
  }
  if (fragmentStart && !(flags & 0x10000n)) track.seekableFragments++;
  const target = targets.get(coordinate);
  if (target) {
    assert.equal(target.track, track.id, "Random access coordinate points to another track");
    assert.equal(flags & 0x10000n, 0n, "Random access target is a non-sync sample");
    const presentation = row.pts + track.presentationShift;
    assert.equal(target.time, presentation < 0n ? 0n : presentation, "Random access presentation time differs");
    target.visited = true; track.indexed++;
  }
  if (!track.first) track.first = row;
  track.last = row;
  const end = row.pts + row.duration;
  if (track.maxEnd === undefined || end > track.maxEnd) track.maxEnd = end;
  track.samples++;
}

function inspectRun(reader, run, header, previous, location, mdats, targets, budget) {
  const info = reader.full(run), count = Number(reader.read(run, run.start + 4, 4));
  assert.equal(info.flags & ~0x000f05, 0, "Unsupported sample run flags");
  assert.ok(count > 0 && (budget.samples += count) <= 10000000, "Excessive fragment samples");
  const sample = fields(reader, run, run.start + 8, info.flags);
  const delta = sample.take(1, 4, null, true);
  let position = delta === null ? previous.dataEnd : header.base + delta;
  assert.ok(position !== null && position >= 0n, "Missing sample data offset");
  const data = containingData(mdats, position), firstFlags = sample.take(4, 4, header.sampleFlags);
  let decode = previous.decode;
  for (let index = 0; index < count; index++) {
    const duration = sample.take(0x100, 4, header.duration), length = sample.take(0x200, 4, header.size);
    const flags = sample.take(0x400, 4, index === 0 ? firstFlags : header.sampleFlags);
    const composition = sample.take(0x800, 4, 0n, info.version === 1);
    const isZeroMovTextEnd = duration === 0n && length === 2n
      && header.track.kind === "sbtl" && reader.read(data, Number(position), 2) === 0n;
    assert.ok((duration > 0n || isZeroMovTextEnd) && length > 0n, "Invalid fragment sample");
    assert.ok(position + length <= BigInt(data.end), "Sample escapes media data");
    recordSample(header.track, targets, [...location, index + 1].join(":"),
      { dts: decode, pts: decode + composition, duration }, flags, location[2] === 1 && index === 0);
    position += length; decode += duration;
  }
  sample.end();
  return { decode, dataEnd: position };
}

function inspectRuns(reader, top, tracks, targets) {
  const mdats = top.filter(box => box.type === "mdat"), budget = { samples: 0 };
  for (const moof of top.filter(box => box.type === "moof")) {
    const trafs = reader.children(moof).filter(box => box.type === "traf");
    assert.ok(trafs.length > 0 && trafs.length <= 256);
    for (const [trafIndex, box] of trafs.entries()) {
      const header = fragmentHeader(reader, moof, trafIndex, box, tracks);
      let previous = { decode: header.decode, dataEnd: null };
      for (const [runIndex, run] of header.runs.entries()) {
        previous = inspectRun(reader, run, header, previous, [moof.offset, trafIndex + 1, runIndex + 1], mdats, targets, budget);
      }
    }
  }
  assert.ok([...targets.values()].every(target => target.visited), "Random access coordinate does not locate a sample");
  for (const track of tracks.values()) assert.equal(track.indexed, track.seekableFragments, "Sync-fragment random access coverage differs");
}

module.exports = { inspectRuns };
