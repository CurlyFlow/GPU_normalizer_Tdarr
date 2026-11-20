"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readEvidenceLines } = require("./mediaEvidenceFiles");
const { decodedAudioTimeline } = require("./mediaClockEvidence");

const STREAM_FIELDS = ["index", "codec_type", "sample_rate", "channels", "time_base"];
const FRAME_FIELDS = ["media_type", "stream_index", "pts", "nb_samples", "channels"];

function clockLine(line) {
  // Compact FFprobe prints headers for explicitly unselected, empty side-data
  // sections. Only those empty markers are structural; nonempty fields reject.
  if (!line || line === "side_data|") return null;
  return line.replace(/(?:\|side_data)+\|$/, "");
}

function compactRow(line, section, fields) {
  line = clockLine(line);
  const [kind, ...parts] = line.split("|");
  assert.equal(kind, section, "Unexpected native audio evidence section");
  const result = {};
  for (const part of parts) {
    const pair = part.match(/^([^=]+)=([^=]+)$/);
    assert.ok(pair && fields.includes(pair[1]) && !Object.hasOwn(result, pair[1]), "Invalid native audio evidence field");
    result[pair[1]] = pair[2];
  }
  assert.deepEqual(Object.keys(result).sort(), [...fields].sort(), "Incomplete native audio evidence");
  return result;
}

function nativeInteger(value, positive = false) {
  assert.match(value, positive ? /^[1-9]\d{0,18}$/ : /^-?\d{1,19}$/);
  const number = BigInt(value);
  assert.ok(number > -(1n << 63n) && number < (1n << 63n), "Native audio integer is outside int64");
  return number;
}

function nativeAudioTimeline(metadata, lines, expected) {
  const base = metadata.time_base.match(/^([1-9]\d{0,18})\/([1-9]\d{0,18})$/);
  assert.ok(base && metadata.codec_type === "audio", "Invalid native audio time base or type");
  for (const [key, observed] of [["channels", expected.channels], ["sample_rate", expected.sample_rate], ["index", expected.index]]) {
    assert.equal(nativeInteger(metadata[key], key !== "index"), BigInt(observed), "Native audio stream identity changed");
  }
  const rate = Number(metadata.sample_rate);
  assert.ok(Number.isSafeInteger(rate) && rate > 0, "Invalid native audio rate");
  function* frames() {
    let streams = 0;
    for (const raw of lines) {
      const line = clockLine(raw);
      if (line === null) continue;
      if (line.startsWith("stream|")) {
        assert.equal(++streams, 1, "Duplicate native audio stream evidence");
        assert.deepEqual(compactRow(line, "stream", STREAM_FIELDS), metadata);
        continue;
      }
      assert.equal(streams, 0, "Native frames followed terminal stream metadata");
      const frame = compactRow(line, "frame", FRAME_FIELDS);
      assert.equal(frame.media_type, "audio");
      assert.equal(frame.stream_index, metadata.index, "Unexpected decoded audio stream");
      assert.equal(frame.channels, metadata.channels, "Decoded audio channel count changed");
      const samples = nativeInteger(frame.nb_samples, true);
      assert.ok(samples <= 2147483647n, "Invalid AVFrame sample count");
      yield { start: { numerator: nativeInteger(frame.pts) * nativeInteger(base[1], true),
        denominator: nativeInteger(base[2], true) }, frameSamples: samples };
    }
    assert.equal(streams, 1, "Missing native audio stream metadata");
  }
  return decodedAudioTimeline(frames(), rate);
}

// Decode directly to native AVFrame evidence. No PCM encoder/muxer may invent
// DTS or round the original container's rational PTS to a PCM output time base.
function probeAudioTimeline(file, index, stream, ffprobePath, directory) {
  assert.ok(Number.isSafeInteger(index) && index >= 0 && index < 256, "Invalid audio ordinal");
  const owned = fs.mkdtempSync(path.join(directory, ".audio-frame-clock-"));
  const output = path.join(owned, "frames.txt");
  try {
    const fd = fs.openSync(output, "wx", 0o600);
    let result;
    try {
      result = spawnSync(ffprobePath, ["-v", "error", "-threads", "1", "-select_streams", `a:${index}`,
        "-show_frames", "-show_streams", "-show_entries",
        "frame=media_type,stream_index,pts,nb_samples,channels:stream=index,codec_type,sample_rate,channels,time_base:stream_tags=:stream_disposition=:stream_side_data=:frame_tags=:frame_side_data=",
        "-of", "compact=p=1:nk=0", file],
      { stdio: ["ignore", fd, "pipe"], encoding: "utf8", timeout: 900000, maxBuffer: 1024 * 1024 });
    } finally { fs.closeSync(fd); }
    if (result.error || result.status !== 0 || result.stderr?.trim()) {
      throw Error(`Complete native audio frame inspection failed: ${result.error?.message || result.stderr?.slice(-4000) || result.status}`);
    }
    let metadata;
    for (const line of readEvidenceLines(output)) {
      if (!line.startsWith("stream|")) continue;
      assert.ok(!metadata, "Duplicate native audio stream metadata");
      metadata = compactRow(line, "stream", STREAM_FIELDS);
    }
    assert.ok(metadata, "Missing native audio stream metadata");
    return nativeAudioTimeline(metadata, readEvidenceLines(output), stream);
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
    fs.rmdirSync(owned);
  }
}

module.exports = { nativeAudioTimeline, probeAudioTimeline };
