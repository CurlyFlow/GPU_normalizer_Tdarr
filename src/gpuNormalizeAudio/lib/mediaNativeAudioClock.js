"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { readEvidenceLines } = require("./mediaEvidenceFiles");
const { createAudioTimelineAccumulator } = require("./mediaClockEvidence");
const { unexpectedMediaDiagnostics } = require("./mediaSourceProbe");

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

function validateStreamIdentity(metadata, expected) {
  assert.equal(metadata.codec_type, "audio", "Invalid native audio time base or type");
  for (const [key, observed] of [["sample_rate", expected.sample_rate], ["index", expected.index]]) {
    assert.equal(nativeInteger(metadata[key], key !== "index"), BigInt(observed), "Native audio stream identity changed");
  }
}

function createAudioTimelineParser(expected, overrideTick = null, knownMetadata = null) {
  const source = knownMetadata || expected;
  const base = String(source?.time_base || "").match(/^([1-9]\d{0,18})\/([1-9]\d{0,18})$/);
  if (!knownMetadata) {
    if (!base) return null;
  } else {
    assert.ok(base && knownMetadata.codec_type === "audio", "Invalid native audio time base or type");
    validateStreamIdentity(knownMetadata, expected);
  }
  const baseNum = nativeInteger(base[1], true);
  const baseDen = nativeInteger(base[2], true);
  const rate = Number(source.sample_rate);
  assert.ok(Number.isSafeInteger(rate) && rate > 0, "Invalid native audio rate");
  const expectedIndex = knownMetadata ? knownMetadata.index : String(expected.index);
  const expectedChannels = BigInt(expected.channels);
  const knownTerminalChannels = knownMetadata ? nativeInteger(knownMetadata.channels, true) : null;
  const tick = overrideTick || { numerator: baseNum, denominator: baseDen };
  const accumulator = createAudioTimelineAccumulator(rate, tick);
  let streams = 0;
  let metadata = knownMetadata;
  let firstFrameChannels = null;
  let lastFrameChannels = null;
  let sawNonExpectedChannels = false;
  return {
    pushLine(raw) {
      const line = clockLine(raw);
      if (line === null) return;
      if (line.startsWith("stream|")) {
        assert.equal(++streams, 1, "Duplicate native audio stream evidence");
        const row = compactRow(line, "stream", STREAM_FIELDS);
        if (knownMetadata) {
          assert.deepEqual(row, knownMetadata);
        } else {
          assert.equal(row.time_base, expected.time_base, "Native audio time base changed");
          validateStreamIdentity(row, expected);
          metadata = row;
        }
        return;
      }
      assert.equal(streams, 0, "Native frames followed terminal stream metadata");
      const frame = compactRow(line, "frame", FRAME_FIELDS);
      assert.equal(frame.media_type, "audio");
      assert.equal(frame.stream_index, expectedIndex, "Unexpected decoded audio stream");
      const frameChannels = nativeInteger(frame.channels, true);
      if (firstFrameChannels === null) {
        firstFrameChannels = frameChannels;
        assert.equal(firstFrameChannels, expectedChannels, "Native audio stream identity changed");
      } else if (frameChannels !== expectedChannels) {
        if (knownTerminalChannels === expectedChannels) {
          assert.equal(frameChannels, expectedChannels, "Decoded audio channel count changed");
        }
        sawNonExpectedChannels = true;
      }
      lastFrameChannels = frameChannels;
      const samples = nativeInteger(frame.nb_samples, true);
      assert.ok(samples <= 2147483647n, "Invalid AVFrame sample count");
      accumulator.push({ start: { numerator: nativeInteger(frame.pts) * baseNum, denominator: baseDen }, frameSamples: samples });
    },
    finish() {
      assert.equal(streams, 1, "Missing native audio stream metadata");
      const terminalChannels = knownTerminalChannels ?? nativeInteger(metadata.channels, true);
      if (terminalChannels === expectedChannels) {
        assert.equal(sawNonExpectedChannels, false, "Decoded audio channel count changed");
      }
      assert.equal(lastFrameChannels, terminalChannels, "Native audio stream identity changed");
      return accumulator.finish();
    },
  };
}

function nativeAudioTimeline(metadata, lines, expected, overrideTick = null) {
  const parser = createAudioTimelineParser(expected, overrideTick, metadata);
  for (const raw of lines) parser.pushLine(raw);
  return parser.finish();
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
  const parser = createAudioTimelineParser(stream, overrideTick);
  if (parser) {
    for (const line of readEvidenceLines(output)) parser.pushLine(line);
    return parser.finish();
  }
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
    const unexpected = unexpectedMediaDiagnostics(result.stderr);
    if (result.error || result.status !== 0 || unexpected) {
      throw Error(`Complete native audio frame inspection failed: ${result.error?.message || unexpected.slice(-4000) || result.status}`);
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
  const parser = createAudioTimelineParser(stream, overrideTick);
  if (!parser) {
    return Promise.resolve().then(() => probeAudioTimeline(file, index, stream, ffprobePath, directory, overrideTick, evidenceCache));
  }
  return new Promise((resolve, reject) => {
    let stderr = "", pending = "", settled = false, escalation = null, parseError = null;
    const decoder = new StringDecoder("utf8");
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      if (error) return reject(error);
      return resolve(value);
    };
    let child;
    try {
      child = spawn(ffprobePath, audioProbeArgs(file, index), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      return reject(error);
    }
    const deadline = setTimeout(() => {
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 5000);
      finish(Error("Complete native audio frame inspection failed: timeout"));
    }, 900000);
    const consume = (text) => {
      if (parseError) return;
      pending += text;
      let start = 0, newline;
      while ((newline = pending.indexOf("\n", start)) >= 0) {
        if (newline - start > 64 * 1024) throw Error("Packet evidence line exceeds64KiB");
        parser.pushLine(pending.slice(start, newline).replace(/\r$/, ""));
        start = newline + 1;
      }
      if (start > 0) pending = pending.slice(start);
      if (pending.length > 64 * 1024) throw Error("Packet evidence line exceeds64KiB");
    };
    child.stdout.on("data", chunk => {
      try { consume(decoder.write(chunk)); }
      catch (error) { parseError = error; child.kill("SIGKILL"); }
    });
    child.stderr.on("data", chunk => {
      if (stderr.length < 16384) stderr += chunk.toString("utf8");
    });
    child.on("error", error => finish(Error(`Complete native audio frame inspection failed: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (parseError) return finish(parseError);
      const unexpected = unexpectedMediaDiagnostics(stderr);
      if (signal || code !== 0 || unexpected) {
        return finish(Error(`Complete native audio frame inspection failed: ${unexpected.slice(-4000) || signal || code}`));
      }
      try {
        const tail = pending + decoder.end();
        if (tail) parser.pushLine(tail.replace(/\r$/, ""));
        const timeline = parser.finish();
        evidenceCache?.timelines?.set(key, timeline);
        return finish(null, timeline);
      } catch (error) {
        return finish(error);
      }
    });
  });
}

module.exports = { nativeAudioTimeline, probeAudioTimeline, probeAudioTimelineAsync, audioTimelineCacheKey };
