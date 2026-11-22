"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { readEvidenceLines } = require("./mediaEvidenceFiles");
const { decodedAudioTimeline } = require("./mediaClockEvidence");

const STREAM_FIELDS = ["index", "codec_type", "sample_rate", "channels", "time_base"];
const FRAME_FIELDS = ["media_type", "stream_index", "pts", "nb_samples", "channels"];

function clockLine(line) {
  // Compact FFprobe prints empty markers for explicitly unselected side-data
  // sections (FFmpeg 5: "|side_data|", FFmpeg 7: trailing "|"). Nonempty fields reject.
  if (!line || line === "side_data|") return null;
  return line.replace(/(?:\|side_data)*\|$/, "");
}

function compactRow(line, section, fields) {
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

function nativeAudioTimeline(metadata, lines, expected, overrideTick = null) {
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
  const tick = overrideTick || { numerator: nativeInteger(base[1], true), denominator: nativeInteger(base[2], true) };
  return decodedAudioTimeline(frames(), rate, tick);
}

function audioTimelineCacheKey(file, index, overrideTick = null) {
  return `${file}\0${index}\0${overrideTick ? `${overrideTick.numerator}/${overrideTick.denominator}` : ""}`;
}

function audioProbeArgs(file, index) {
  return ["-v", "error", "-threads", "1", "-select_streams", `a:${index}`,
    "-show_frames", "-show_streams", "-show_entries",
    "frame=media_type,stream_index,pts,nb_samples,channels:stream=index,codec_type,sample_rate,channels,time_base:stream_tags=:stream_disposition=:stream_side_data=:frame_tags=:frame_side_data=",
    "-of", "compact=p=1:nk=0", file];
}

function parseAudioTimelineFile(output, stream, overrideTick = null) {
  let metadata;
  for (const line of readEvidenceLines(output)) {
    if (!line.startsWith("stream|")) continue;
    assert.ok(!metadata, "Duplicate native audio stream metadata");
    metadata = compactRow(clockLine(line), "stream", STREAM_FIELDS);
  }
  assert.ok(metadata, "Missing native audio stream metadata");
  return nativeAudioTimeline(metadata, readEvidenceLines(output), stream, overrideTick);
}

// Decode directly to native AVFrame evidence. No PCM encoder/muxer may invent
// DTS or round the original container's rational PTS to a PCM output time base.
function probeAudioTimeline(file, index, stream, ffprobePath, directory, overrideTick = null, evidenceCache = null) {
  assert.ok(Number.isSafeInteger(index) && index >= 0 && index < 256, "Invalid audio ordinal");
  const key = audioTimelineCacheKey(file, index, overrideTick);
  if (evidenceCache?.timelines?.has(key)) return evidenceCache.timelines.get(key);
  const owned = fs.mkdtempSync(path.join(directory, ".audio-frame-clock-"));
  const output = path.join(owned, "frames.txt");
  try {
    const fd = fs.openSync(output, "wx", 0o600);
    let result;
    try {
      result = spawnSync(ffprobePath, audioProbeArgs(file, index),
        { stdio: ["ignore", fd, "pipe"], encoding: "utf8", timeout: 900000, maxBuffer: 1024 * 1024 });
    } finally { fs.closeSync(fd); }
    if (result.error || result.status !== 0 || result.stderr?.trim()) {
      throw Error(`Complete native audio frame inspection failed: ${result.error?.message || result.stderr?.slice(-4000) || result.status}`);
    }
    const timeline = parseAudioTimelineFile(output, stream, overrideTick);
    evidenceCache?.timelines?.set(key, timeline);
    return timeline;
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
    fs.rmdirSync(owned);
  }
}

function probeAudioTimelineAsync(file, index, stream, ffprobePath, directory, overrideTick = null, evidenceCache = null) {
  assert.ok(Number.isSafeInteger(index) && index >= 0 && index < 256, "Invalid audio ordinal");
  const key = audioTimelineCacheKey(file, index, overrideTick);
  if (evidenceCache?.timelines?.has(key)) return Promise.resolve(evidenceCache.timelines.get(key));
  const owned = fs.mkdtempSync(path.join(directory, ".audio-frame-clock-"));
  const output = path.join(owned, "frames.txt");
  const fd = fs.openSync(output, "wx", 0o600);
  return new Promise((resolve, reject) => {
    let stderr = "", settled = false, closed = false, escalation = null;
    const closeFd = () => {
      if (closed) return;
      closed = true;
      try { fs.closeSync(fd); } catch {}
    };
    const cleanup = () => {
      closeFd();
      try { if (fs.existsSync(output)) fs.unlinkSync(output); } catch {}
      try { fs.rmdirSync(owned); } catch {}
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      cleanup();
      if (error) return reject(error);
      return resolve(value);
    };
    let child;
    try {
      child = spawn(ffprobePath, audioProbeArgs(file, index), { stdio: ["ignore", fd, "pipe"] });
    } catch (error) {
      cleanup();
      return reject(error);
    }
    const deadline = setTimeout(() => {
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 5000);
      finish(Error("Complete native audio frame inspection failed: timeout"));
    }, 900000);
    child.stderr.on("data", chunk => {
      if (stderr.length < 16384) stderr += chunk.toString("utf8");
    });
    child.on("error", error => finish(Error(`Complete native audio frame inspection failed: ${error.message}`)));
    child.on("close", (code, signal) => {
      closeFd();
      if (signal || code !== 0 || stderr.trim()) {
        return finish(Error(`Complete native audio frame inspection failed: ${stderr.slice(-4000) || signal || code}`));
      }
      try {
        const timeline = parseAudioTimelineFile(output, stream, overrideTick);
        evidenceCache?.timelines?.set(key, timeline);
        return finish(null, timeline);
      } catch (error) {
        return finish(error);
      }
    });
  });
}

module.exports = { nativeAudioTimeline, probeAudioTimeline, probeAudioTimelineAsync, audioTimelineCacheKey };
