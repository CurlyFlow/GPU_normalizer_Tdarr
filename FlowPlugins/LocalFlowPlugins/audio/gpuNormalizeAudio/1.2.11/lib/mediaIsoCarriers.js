"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { isoBoxes } = require("./mediaIsoBoxes");
const { reduceRational } = require("./audioClockPlan");

function escapeFfmetadata(value) {
  return String(value ?? "").replace(/([=;#\\\n\r])/g, "\\$1");
}

function parseTimeBase(base) {
  const match = String(base || "").match(/^([1-9]\d{0,18})\/([1-9]\d{0,18})$/);
  if (!match) return null;
  return { num: BigInt(match[1]), den: BigInt(match[2]) };
}

function makeZeroOriginShift(media) {
  let minNum = 0n, minDen = 1n;
  for (const stream of media?.streams || []) {
    if (!["video", "audio", "subtitle"].includes(stream?.codec_type)) continue;
    const base = parseTimeBase(stream.time_base);
    if (!base || !/^-\d+$/.test(String(stream.start_pts ?? ""))) continue;
    const pts = BigInt(stream.start_pts) * base.num;
    if (pts * minDen < minNum * base.den) {
      minNum = pts;
      minDen = base.den;
    }
  }
  if (minNum >= 0n) return { num: 0n, den: 1n };
  const reduced = reduceRational(-minNum, minDen);
  return { num: reduced.numerator, den: reduced.denominator };
}

function shiftChapterTick(tick, base, shift, targetDen) {
  const scaled = (BigInt(tick) * base.num * shift.den + shift.num * base.den) * targetDen;
  const denom = base.den * shift.den;
  assert.equal(scaled % denom, 0n, "Unrepresentable shifted chapter boundary");
  return scaled / denom;
}

// FFmpeg movenc.c (`mov_create_chapter_track`) anchors chapter sample 0 at dts=0,
// clamping or shifting `chapters[0]` when `chapters[0].start > 0` (moving a single
// trailing Credits chapter to 00:00:00). Prepending an explicit untitled `[0..start]`
// pre-chapter preserves every source chapter's exact boundary in QuickTime/MP4/Plex.
function buildMp4LeadingChapterMetadata(media) {
  const formats = String(media?.format?.format_name || "").split(",");
  if (formats.includes("mov")) return null;
  const chapters = media?.chapters;
  if (!Array.isArray(chapters) || chapters.length === 0) return null;
  const firstBase = parseTimeBase(chapters[0].time_base);
  if (!firstBase || !/^-?\d+$/.test(String(chapters[0].start))) return null;
  const firstStart = BigInt(chapters[0].start);
  if (firstStart <= 0n) return null;

  const shift = makeZeroOriginShift(media);
  const lcmDen = (a, b) => reduceRational(a, b).numerator * b;
  const firstDen = lcmDen(firstBase.den, shift.den);
  const shiftedFirstStart = shiftChapterTick(firstStart, firstBase, shift, firstDen);

  const lines = [
    ";FFMETADATA1",
    "[CHAPTER]",
    `TIMEBASE=1/${firstDen}`,
    "START=0",
    `END=${shiftedFirstStart}`,
    "title=",
  ];
  for (const chapter of chapters) {
    const base = parseTimeBase(chapter.time_base);
    assert.ok(base && /^-?\d+$/.test(String(chapter.start)) && /^-?\d+$/.test(String(chapter.end)),
      "Invalid source chapter timing");
    const targetDen = lcmDen(base.den, shift.den);
    const startTick = shiftChapterTick(chapter.start, base, shift, targetDen);
    const endTick = shiftChapterTick(chapter.end, base, shift, targetDen);
    const rawTitle = Object.entries(chapter.tags || {}).find(([key]) => key.toLowerCase() === "title")?.[1] ?? "";
    lines.push(
      "[CHAPTER]",
      `TIMEBASE=1/${targetDen}`,
      `START=${startTick}`,
      `END=${endTick}`,
      `title=${escapeFfmetadata(rawTitle)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function wireMp4ChapterMetadataInput(inputs, outputs, metadataFile) {
  let inputCount = 0;
  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i] === "-i") inputCount += 1;
  }
  const nextInputs = [...inputs, "-f", "ffmetadata", "-i", metadataFile];
  const nextOutputs = [...outputs];
  for (let i = 0; i + 1 < nextOutputs.length; i++) {
    if (nextOutputs[i] === "-map_chapters") {
      nextOutputs[i + 1] = String(inputCount);
    }
  }
  return { inputs: nextInputs, outputs: nextOutputs };
}

function doviSideData(stream) {
  return (stream?.side_data_list || []).find(item => item?.side_data_type === "DOVI configuration record") || null;
}

// Dolby Vision ISOBMFF §2.2 / FFmpeg libavformat/dovi_isom.c `ff_isom_put_dvcc_dvvc`.
function encodeDoviConfigBox(dovi, boxType = "dvwC") {
  assert.ok(/^[A-Za-z0-9]{4}$/.test(boxType), "Invalid DOVI box type");
  const major = Number(dovi.dv_version_major ?? 1) & 0xff;
  const minor = Number(dovi.dv_version_minor ?? 0) & 0xff;
  const profile = Number(dovi.dv_profile ?? 0) & 0x7f;
  const level = Number(dovi.dv_level ?? 0) & 0x3f;
  const rpu = dovi.rpu_present_flag ? 1 : 0;
  const el = dovi.el_present_flag ? 1 : 0;
  const bl = dovi.bl_present_flag ? 1 : 0;
  const compat = Number(dovi.dv_bl_signal_compatibility_id ?? 0) & 0x0f;
  const compression = Number(dovi.dv_md_compression ?? 0) & 0x03;

  const box = Buffer.alloc(32, 0);
  box.writeUInt32BE(32, 0);
  box.write(boxType, 4, 4, "ascii");
  box[8] = major;
  box[9] = minor;
  const word = (profile << 9) | (level << 3) | (rpu << 2) | (el << 1) | bl;
  box.writeUInt16BE(word, 10);
  box[12] = (compat << 4) | (compression << 2);
  return box;
}

function shiftChunkOffsets(buf, moov, reader, insertPos, delta) {
  for (const trak of reader.children(moov).filter(box => box.type === "trak")) {
    const mdia = reader.one(reader.children(trak), "mdia", true);
    const minf = mdia ? reader.one(reader.children(mdia), "minf", true) : null;
    const stbl = minf ? reader.one(reader.children(minf), "stbl", true) : null;
    if (!stbl) continue;
    for (const child of reader.children(stbl)) {
      if (child.type === "stco") {
        const count = buf.readUInt32BE(child.start + 4);
        assert.equal(child.start + 8 + count * 4, child.end, "Invalid stco box");
        for (let i = 0; i < count; i++) {
          const at = child.start + 8 + i * 4;
          const cur = buf.readUInt32BE(at);
          if (cur >= insertPos) {
            assert.ok(cur + delta <= 0xffffffff, "32-bit stco chunk offset overflow");
            buf.writeUInt32BE(cur + delta, at);
          }
        }
      } else if (child.type === "co64") {
        const count = buf.readUInt32BE(child.start + 4);
        assert.equal(child.start + 8 + count * 8, child.end, "Invalid co64 box");
        for (let i = 0; i < count; i++) {
          const at = child.start + 8 + i * 8;
          const cur = buf.readBigUInt64BE(at);
          if (cur >= BigInt(insertPos)) {
            buf.writeBigUInt64BE(cur + BigInt(delta), at);
          }
        }
      }
    }
  }
}

function addBoxSize(buf, box, delta) {
  const size32 = buf.readUInt32BE(box.offset);
  if (size32 === 1) {
    buf.writeBigUInt64BE(buf.readBigUInt64BE(box.offset + 8) + BigInt(delta), box.offset + 8);
  } else {
    assert.ok(size32 > 1 && size32 + delta <= 0xffffffff, `Box ${box.type} size overflow`);
    buf.writeUInt32BE(size32 + delta, box.offset);
  }
}

function writeReplacedMoov(mp4File, stat, moov, moovBuf) {
  const temp = path.join(path.dirname(mp4File), `.iso-dvwc-${randomUUID()}.tmp`);
  const inFd = fs.openSync(mp4File, "r");
  let outFd = -1;
  let renamed = false;
  try {
    outFd = fs.openSync(temp, "wx", stat.mode & 0o777);
    const copyRange = (start, end) => {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, end - start)));
      for (let pos = start; pos < end;) {
        const len = fs.readSync(inFd, chunk, 0, Math.min(chunk.length, end - pos), pos);
        assert.ok(len > 0, "Unexpected EOF copying MP4 range");
        assert.equal(fs.writeSync(outFd, chunk, 0, len), len);
        pos += len;
      }
    };
    copyRange(0, moov.offset);
    assert.equal(fs.writeSync(outFd, moovBuf, 0, moovBuf.length), moovBuf.length);
    copyRange(moov.end, stat.size);
    fs.fsyncSync(outFd);
    fs.closeSync(outFd);
    outFd = -1;
    fs.renameSync(temp, mp4File);
    renamed = true;
  } finally {
    fs.closeSync(inFd);
    if (outFd >= 0) fs.closeSync(outFd);
    if (!renamed) fs.rmSync(temp, { force: true });
  }
}

// Preserve Dolby Vision Profile 10 (`dvwC`) on AV1 (`av01`) MP4 tracks when the
// upstream FFmpeg muxer omits `dvwC` or writes `dvvC` due to `dv_profile > 10`.
function ensureMp4Av1DoviBoxes(sourceStreams, mp4File) {
  const av1Dovi = (sourceStreams || [])
    .filter(stream => (stream.codec_type || stream.type) === "video")
    .map(stream => ((stream.codec_name === "av1" && Number(doviSideData(stream)?.dv_profile) >= 10)
      ? doviSideData(stream) : null));
  if (!av1Dovi.some(Boolean) || !mp4File || !fs.existsSync(mp4File)) return false;

  const stat = fs.statSync(mp4File);
  const fd = fs.openSync(mp4File, "r");
  let top, moov, hasMoof = false;
  try {
    const reader = isoBoxes((offset, length) => {
      const out = Buffer.alloc(length);
      const read = fs.readSync(fd, out, 0, length, offset);
      return out.subarray(0, read);
    }, stat.size);
    top = reader.boxes(0, stat.size);
    moov = reader.one(top, "moov", true);
    hasMoof = top.some(box => box.type === "moof");
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
  if (!moov) return false;

  let moovBuf = Buffer.alloc(moov.end - moov.offset);
  const rfd = fs.openSync(mp4File, "r");
  try {
    assert.equal(fs.readSync(rfd, moovBuf, 0, moovBuf.length, moov.offset), moovBuf.length);
  } finally {
    fs.closeSync(rfd);
  }

  let modified = false;
  let needsSplice = false;
  const parseMoov = (buf) => {
    const reader = isoBoxes((offset, length) => buf.subarray(offset, offset + length), buf.length);
    const rootMoov = reader.one(reader.boxes(0, buf.length), "moov");
    const videoEntries = [];
    for (const trak of reader.children(rootMoov).filter(b => b.type === "trak")) {
      const mdia = reader.one(reader.children(trak), "mdia", true);
      const hdlr = mdia ? reader.one(reader.children(mdia), "hdlr", true) : null;
      if (!hdlr || hdlr.end - hdlr.start < 12) continue;
      if (buf.toString("ascii", hdlr.start + 8, hdlr.start + 12) !== "vide") continue;
      const minf = reader.one(reader.children(mdia), "minf");
      const stbl = reader.one(reader.children(minf), "stbl");
      const stsd = reader.one(reader.children(stbl), "stsd");
      const entries = reader.boxes(stsd.start + 8, stsd.end);
      videoEntries.push({ rootMoov, trak, mdia, minf, stbl, stsd, entry: entries[0], reader });
    }
    return videoEntries;
  };

  parseMoov(moovBuf).forEach((vid, vIdx) => {
    const dovi = av1Dovi[vIdx];
    if (!dovi || vid.entry?.type !== "av01" || vid.entry.end - vid.entry.start < 78) return;
    const subBoxes = vid.reader.boxes(vid.entry.start + 78, vid.entry.end);
    if (subBoxes.some(b => b.type === "dvwC")) return;
    const wrongFourcc = subBoxes.find(b => b.type === "dvvC" && b.end - b.offset === 32);
    if (wrongFourcc) {
      moovBuf.write("dvwC", wrongFourcc.offset + 4, 4, "ascii");
      modified = true;
    } else if (!hasMoof) {
      needsSplice = true;
    }
  });

  if (needsSplice) {
    for (let vIdx = 0; vIdx < av1Dovi.length; vIdx++) {
      const dovi = av1Dovi[vIdx];
      if (!dovi) continue;
      const vid = parseMoov(moovBuf)[vIdx];
      if (!vid || vid.entry?.type !== "av01" || vid.entry.end - vid.entry.start < 78) continue;
      const subBoxes = vid.reader.boxes(vid.entry.start + 78, vid.entry.end);
      if (subBoxes.some(b => b.type === "dvwC" || b.type === "dvvC" || b.type === "dvcC")) continue;
      const dvwc = encodeDoviConfigBox(dovi, "dvwC");
      const insertLocal = vid.entry.end;
      shiftChunkOffsets(moovBuf, vid.rootMoov, vid.reader, moov.offset + insertLocal, dvwc.length);
      for (const parent of [vid.entry, vid.stsd, vid.stbl, vid.minf, vid.mdia, vid.trak, vid.rootMoov]) {
        addBoxSize(moovBuf, parent, dvwc.length);
      }
      moovBuf = Buffer.concat([moovBuf.subarray(0, insertLocal), dvwc, moovBuf.subarray(insertLocal)]);
      modified = true;
    }
  }

  if (!modified) return false;
  writeReplacedMoov(mp4File, stat, moov, moovBuf);
  return true;
}

module.exports = {
  buildMp4LeadingChapterMetadata,
  encodeDoviConfigBox,
  ensureMp4Av1DoviBoxes,
  wireMp4ChapterMetadataInput,
};
