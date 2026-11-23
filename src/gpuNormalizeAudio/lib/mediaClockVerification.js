"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { fileDigest } = require("./mediaEvidenceFiles");
const { framehash, framehashCacheKey, framehashToFileAsync } = require("./mediaFrameEvidence");
const { copiedVideoShift, compareAudioTimelines, comparePacketPayloads } = require("./mediaClockEvidence");
const { probeAudioTimeline, probeAudioTimelineAsync, audioTimelineCacheKey } = require("./mediaNativeAudioClock");
const { resolveVideoMap } = require("./mediaClockProtocol");
const { audioPresentation } = require("./mediaAudioWindow");
const { usesNormalizedEof, resolveNormalizedEofCounts, verifyNormalizedAacWindow } = require("./mediaAudioEofContext");

function createEvidenceCache(directory) {
  const cacheDir = fs.mkdtempSync(path.join(directory, ".evidence-cache-"));
  return {
    directory: cacheDir,
    timelines: new Map(),
    framehashes: new Map(),
    nextId: 0,
    dispose() {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    },
  };
}

async function runTasksWithConcurrency(tasks, limit = 6) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      try { await task(); } catch {}
    }
  });
  await Promise.all(workers);
}

async function prewarmClockEvidence(spec, evidenceCache, extraFramehashes = []) {
  if (!evidenceCache) return;
  const { sourceFile, candidateFile, sourceStreams, candidateStreams, audioMap, videoMap = null,
    ffmpegPath, ffprobePath, directory, sourceClockTick = null } = spec;
  const tasks = [];
  const queuedFramehash = new Set();
  const queuedTimeline = new Set();
  const enqueueFramehash = (file, selector, codec = "copy", aliases = []) => {
    if (!evidenceCache.directory || !file || !selector) return;
    const key = framehashCacheKey(file, selector, codec);
    if (evidenceCache.framehashes.has(key) || queuedFramehash.has(key)) return;
    queuedFramehash.add(key);
    for (const alias of aliases) queuedFramehash.add(framehashCacheKey(file, alias, codec));
    tasks.push(async () => {
      const evidence = path.join(evidenceCache.directory, `packets-${++evidenceCache.nextId}.framehash`);
      await framehashToFileAsync(file, selector, codec, ffmpegPath, evidence);
      evidenceCache.framehashes.set(key, evidence);
      for (const alias of aliases) evidenceCache.framehashes.set(framehashCacheKey(file, alias, codec), evidence);
    });
  };
  const enqueueTimeline = (file, index, stream, tick = null) => {
    if (!file || !stream || !Number.isSafeInteger(index) || index < 0) return;
    const key = audioTimelineCacheKey(file, index, tick);
    if (evidenceCache.timelines.has(key) || queuedTimeline.has(key)) return;
    queuedTimeline.add(key);
    tasks.push(() => probeAudioTimelineAsync(file, index, stream, ffprobePath, directory, tick, evidenceCache));
  };
  const sourceVideos = sourceStreams.filter(stream => stream.type === "video");
  const candidateVideos = candidateStreams.filter(stream => stream.type === "video");
  const mappedVideos = resolveVideoMap(videoMap, sourceVideos.length);
  for (const map of mappedVideos) {
    const srcStream = sourceVideos[map.sourceIndex];
    const candStream = candidateVideos[map.candidateIndex];
    if (srcStream) enqueueFramehash(sourceFile, `0:v:${map.sourceIndex}`, "copy", [`0:${srcStream.index}`]);
    if (candStream) enqueueFramehash(candidateFile, `0:v:${map.candidateIndex}`, "copy", [`0:${candStream.index}`]);
  }
  for (const extra of extraFramehashes) {
    enqueueFramehash(extra.file, extra.selector, extra.codec || "copy", extra.aliases || []);
  }
  const expectedCoarseTick = (stream, overrideTick) => {
    const rate = Number(stream?.sample_rate);
    if (!Number.isSafeInteger(rate) || rate <= 0) return null;
    if (overrideTick) {
      return overrideTick.numerator * BigInt(rate) > overrideTick.denominator ? overrideTick : null;
    }
    const match = String(stream?.time_base || "").match(/^([1-9]\d{0,18})\/([1-9]\d{0,18})$/);
    if (!match) return null;
    const tick = { numerator: BigInt(match[1]), denominator: BigInt(match[2]) };
    return tick.numerator * BigInt(rate) > tick.denominator ? tick : null;
  };
  const sourceAudio = sourceStreams.filter(stream => stream.type === "audio");
  const candidateAudio = candidateStreams.filter(stream => stream.type === "audio");
  const sourceTick = sourceClockTick ? { numerator: BigInt(sourceClockTick.numerator), denominator: BigInt(sourceClockTick.denominator) } : null;
  for (const map of audioMap) {
    const src = sourceAudio[map.sourceIndex], cand = candidateAudio[map.candidateIndex];
    if (src) enqueueTimeline(sourceFile, map.sourceIndex, src, sourceTick);
    const candTick = map.compareSamples ? expectedCoarseTick(src, sourceTick) : null;
    if (cand) enqueueTimeline(candidateFile, map.candidateIndex, cand, candTick);
  }
  await runTasksWithConcurrency(tasks, 6);
}

function readStreamExtradata(file, selector, ffprobePath) {
  const select = typeof selector === "number" ? `v:${selector}` : String(selector);
  const result = spawnSync(ffprobePath, ["-v", "error", "-select_streams", select,
    "-show_data", "-show_streams", file], { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  const bytes = [];
  let inExtradata = false;
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    if (line === "extradata=") { inExtradata = true; continue; }
    if (!inExtradata) continue;
    const match = line.match(/^[0-9a-fA-F]{8}:\s+([0-9a-fA-F ]{1,40})/);
    if (!match) break;
    const hex = match[1].replace(/\s+/g, "");
    for (let offset = 0; offset + 1 < hex.length; offset += 2) {
      bytes.push(Number.parseInt(hex.slice(offset, offset + 2), 16));
    }
  }
  return bytes.length ? Buffer.from(bytes) : null;
}

function stripMovTextBtrt(raw) {
  if (!raw || raw.length === 0) return null;
  let end = raw.length;
  // FFmpeg movenc appends an optional 20-byte `btrt` bitrate box when remuxing
  // `mov_text` (`tx3g`) tracks without `-write_btrt 0`; strip trailing `btrt`
  // boxes and require exact byte identity of the underlying `tx3g` header.
  while (end >= 20 && raw.readUInt32BE(end - 20) === 20
      && raw.subarray(end - 16, end - 12).toString("ascii") === "btrt") {
    end -= 20;
  }
  return end > 0 ? raw.subarray(0, end) : null;
}

function equivalentMovTextExtradata(sourceFile, sourceStreamIndex, candidateFile, candidateStreamIndex, ffprobePath) {
  if (!ffprobePath) return false;
  const before = stripMovTextBtrt(readStreamExtradata(sourceFile, String(sourceStreamIndex), ffprobePath));
  const after = stripMovTextBtrt(readStreamExtradata(candidateFile, String(candidateStreamIndex), ffprobePath));
  return Boolean(before && after && Buffer.compare(before, after) === 0);
}

function normalizeHvccCompleteness(raw) {
  if (!raw || raw.length < 23 || raw[0] !== 1) return null;
  const copy = Buffer.from(raw);
  const numArrays = copy[22];
  let cursor = 23;
  for (let arrayIndex = 0; arrayIndex < numArrays; arrayIndex++) {
    if (cursor + 3 > copy.length) return null;
    copy[cursor] &= 0x7f; // Clear only ISO 14496-15 array_completeness bit (0x80).
    const numNalus = copy.readUInt16BE(cursor + 1);
    cursor += 3;
    for (let nalu = 0; nalu < numNalus; nalu++) {
      if (cursor + 2 > copy.length) return null;
      const len = copy.readUInt16BE(cursor);
      cursor += 2 + len;
      if (cursor > copy.length) return null;
    }
  }
  return cursor === copy.length ? copy : null;
}

function equivalentHevcExtradata(sourceFile, sourceIndex, candidateFile, candidateIndex, ffprobePath) {
  if (!ffprobePath) return false;
  const before = normalizeHvccCompleteness(readStreamExtradata(sourceFile, sourceIndex, ffprobePath));
  const after = normalizeHvccCompleteness(readStreamExtradata(candidateFile, candidateIndex, ffprobePath));
  return Boolean(before && after && Buffer.compare(before, after) === 0);
}

function verifyMappedAudioClocks({ sourceFile, candidateFile, sourceStreams, candidateStreams, audioMap, ffmpegPath, ffprobePath, directory, eofContext = null, sourceClockTick = null, evidenceCache = null }, offset) {
  const sourceAudio = sourceStreams.filter(stream => stream.type === "audio");
  const candidateAudio = candidateStreams.filter(stream => stream.type === "audio");
  const errors = [], audio = [];
  const sourceTick = sourceClockTick ? { numerator: BigInt(sourceClockTick.numerator), denominator: BigInt(sourceClockTick.denominator) } : null;
  let candidateWindows = null;
  if (audioMap.length === 0 && sourceAudio.length > 0) errors.push("Empty audio mapping requires an audio-free original");
  if (audioMap.length !== candidateAudio.length
      || audioMap.some((map, index) => map.candidateIndex !== index)) errors.push("Audio clock mapping is incomplete or unordered");
  for (const map of audioMap) {
    try {
      const source = sourceAudio[map.sourceIndex], candidate = candidateAudio[map.candidateIndex];
      if (!Number.isSafeInteger(map.sourceIndex) || map.sourceIndex < 0 || !source || !candidate) {
        throw new Error("Original or candidate timing stream is missing");
      }
      if (!Number.isSafeInteger(map.rate) || map.rate <= 0 || map.rate !== Number(candidate.sample_rate)
          || map.channels !== Number(candidate.channels)) throw new Error("Native audio specification differs or is unknown");
      if (![4, 8].includes(map.sampleBytes)) throw new Error("Unsupported clock evidence sample width");
      let sourceTimeline;
      try {
        sourceTimeline = probeAudioTimeline(sourceFile, map.sourceIndex, source, ffprobePath, directory, sourceTick, evidenceCache);
      } catch (sourceError) {
        if (map.compareSamples && source.codec_name === candidate.codec_name && ffmpegPath
            && /Complete native audio frame inspection failed/.test(sourceError.message)) {
          const copied = comparePacketPayloads(
            framehash(sourceFile, `0:a:${map.sourceIndex}`, "copy", ffmpegPath, directory, null, evidenceCache),
            framehash(candidateFile, `0:a:${map.candidateIndex}`, "copy", ffmpegPath, directory, null, evidenceCache));
          audio.push({ map_id: map.id, status: "pass", packetCopyFallback: true, packets: copied.packets });
          continue;
        }
        throw sourceError;
      }
      const candidateTick = map.compareSamples && sourceTimeline.coarseTick ? sourceTimeline.coarseTick : null;
      const candidateTimeline = probeAudioTimeline(candidateFile, map.candidateIndex, candidate, ffprobePath, directory, candidateTick, evidenceCache);
      const eofEntry = eofContext?.streams?.[map.candidateIndex];
      let timeline;
      if (eofEntry?.mode === "normalized-mkv-aac") {
        assert.equal(eofEntry.id, map.id, "Normalized MKV EOF entry ID differs");
        assert.equal(eofEntry.sourceIndex, map.sourceIndex, "Normalized MKV EOF source ordinal differs");
        assert.equal(candidateTimeline.rate, eofEntry.encodedRate, "Normalized MKV AAC rate differs from EOF context");
        timeline = compareAudioTimelines(sourceTimeline, candidateTimeline, offset, BigInt(eofEntry.cpuDecodedSamples));
      } else if (usesNormalizedEof(eofEntry, sourceTimeline)) {
        assert.equal(eofEntry.id, map.id, "Normalized EOF entry ID differs");
        assert.equal(eofEntry.sourceIndex, map.sourceIndex, "Normalized EOF source ordinal differs");
        assert.equal(candidateTimeline.rate, eofEntry.encodedRate, "Normalized AAC rate differs from EOF context");
        const domain = resolveNormalizedEofCounts(eofEntry, sourceTimeline.samples);
        timeline = compareAudioTimelines(sourceTimeline, candidateTimeline, offset, domain.decodedSamples);
        candidateWindows ??= audioPresentation(candidateFile).tracks;
        verifyNormalizedAacWindow(eofEntry, candidateWindows[map.candidateIndex], domain, offset);
      } else {
        timeline = compareAudioTimelines(sourceTimeline, candidateTimeline, offset);
      }
      audio.push({ map_id: map.id, status: "pass", ...timeline });
    } catch (error) {
      audio.push({ map_id: map.id, status: "fail" });
      errors.push(`${map.id}: ${error.message}`);
    }
  }
  return { audio, errors };
}

function verifyVideoClocks({ sourceFile, candidateFile, sourceStreams, candidateStreams, videoMap = null, ffmpegPath, ffprobePath = null, directory, evidenceCache = null }) {
  const sourceVideos = sourceStreams.filter(stream => stream.type === "video");
  const candidateVideos = candidateStreams.filter(stream => stream.type === "video");
  const mappedVideos = resolveVideoMap(videoMap, sourceVideos.length);
  const errors = [], videos = [];
  let offset = { numerator: 0n, denominator: 1n };
  if (mappedVideos.length !== candidateVideos.length) errors.push("Video stream count changed");
  for (const map of mappedVideos) {
    const index = map.candidateIndex;
    try {
      const srcStream = sourceVideos[map.sourceIndex], candStream = candidateVideos[index];
      const hevc = srcStream?.codec_name === "hevc" && candStream?.codec_name === "hevc";
      const shift = copiedVideoShift(
        framehash(sourceFile, `0:v:${map.sourceIndex}`, "copy", ffmpegPath, directory, null, evidenceCache),
        framehash(candidateFile, `0:v:${index}`, "copy", ffmpegPath, directory, null, evidenceCache),
        hevc ? { allowEquivalentExtradata: () => equivalentHevcExtradata(sourceFile, map.sourceIndex, candidateFile, index, ffprobePath) } : {});
      if (index > 0 && shift.numerator * offset.denominator !== offset.numerator * shift.denominator) {
        throw new Error("Video streams do not share one timeline translation");
      }
      offset = shift;
      videos.push({ index, source_index: map.sourceIndex, status: "pass" });
    } catch (error) {
      videos.push({ index, source_index: map.sourceIndex, status: "fail" });
      errors.push(`video ${index}: ${error.message}`);
    }
  }
  return { source_video_streams: sourceVideos.length, videoMap: mappedVideos,
    required_video_streams: mappedVideos.length, videos, offset, errors };
}

function verifyClockFiles(spec) {
  const { sourceFile, candidateFile, sourceStreams, candidateStreams, audioMap, ffmpegPath, ffprobePath, directory, eofContext = null, sourceClockTick = null } = spec;
  const evidenceCache = spec.evidenceCache || { timelines: new Map() };
  const inputs = [...new Set([sourceFile, candidateFile])].map(file => ({
    file,
    identity: spec.initialDigests?.get(file) || fileDigest(file),
  }));
  const { offset, errors, ...video } = verifyVideoClocks({ ...spec, evidenceCache });
  if (audioMap.length === 0 && video.required_video_streams === 0) errors.push("Media clock proof covers no streams");
  const clocks = verifyMappedAudioClocks({ sourceFile, candidateFile, sourceStreams, candidateStreams, audioMap, ffmpegPath, ffprobePath, directory, eofContext, sourceClockTick, evidenceCache }, offset);
  errors.push(...clocks.errors);
  if (!spec.deferPostDigest) {
    for (const input of inputs) {
      if (JSON.stringify(fileDigest(input.file)) !== JSON.stringify(input.identity)) errors.push("Media input changed during A/V comparison");
    }
  }
  return { inputs, ...video, audio: clocks.audio,
    common_offset: { numerator: String(offset.numerator), denominator: String(offset.denominator) }, errors };
}

module.exports = { verifyClockFiles, verifyVideoClocks, verifyMappedAudioClocks, createEvidenceCache, prewarmClockEvidence,
  equivalentMovTextExtradata, stripMovTextBtrt };
