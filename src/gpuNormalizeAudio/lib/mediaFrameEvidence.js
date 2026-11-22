"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { readEvidenceLines } = require("./mediaEvidenceFiles");

function framehashArgs(file, selector, codec, evidence, nativeVideo = null) {
  const video = nativeVideo ? ["-threads", "1", "-fps_mode", "passthrough", "-pix_fmt", nativeVideo.pix_fmt,
    "-enc_time_base", nativeVideo.time_base] : [];
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-threads", "1",
    "-filter_threads", "1", "-filter_complex_threads", "1", "-xerror", "-copyts", "-i", file,
    "-map", selector, "-c", codec, ...video, "-f", "framehash", evidence];
}

function framehashCacheKey(file, selector, codec) {
  return `${file}\0${selector}\0${codec}`;
}

function framehashToFileAsync(file, selector, codec, ffmpegPath, evidence, nativeVideo = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, framehashArgs(file, selector, codec, evidence, nativeVideo),
      { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "", settled = false, escalation = null;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      if (error) {
        try { fs.rmSync(evidence, { force: true }); } catch {}
        return reject(error);
      }
      return resolve(evidence);
    };
    const deadline = setTimeout(() => {
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 5000);
      finish(new Error("Complete packet/frame evidence failed: timeout"));
    }, 900000);
    child.stderr.on("data", chunk => {
      if (stderr.length < 16384) stderr += chunk.toString("utf8");
    });
    child.on("error", err => finish(new Error(`Complete packet/frame evidence failed: ${String(err).slice(-1000)}`)));
    child.on("close", (code, signal) => {
      if (signal || code !== 0 || stderr.trim()) {
        return finish(new Error(`Complete packet/frame evidence failed: ${String(stderr || signal || "missing exit").slice(-1000)}`));
      }
      return finish(null);
    });
  });
}

// Isolated verification worker only. Evidence remains streamed and privately owned.
function* framehash(file, selector, codec, ffmpegPath, directory, nativeVideo = null, evidenceCache = null) {
  if (evidenceCache?.framehashes && nativeVideo === null) {
    const key = framehashCacheKey(file, selector, codec);
    const cached = evidenceCache.framehashes.get(key);
    if (cached) {
      yield* readEvidenceLines(cached);
      return;
    }
    if (evidenceCache.directory) {
      const evidence = path.join(evidenceCache.directory, `packets-${++evidenceCache.nextId}.framehash`);
      const result = spawnSync(ffmpegPath, framehashArgs(file, selector, codec, evidence, null),
        { encoding: "utf8", timeout: 900000, maxBuffer: 1024 * 1024 });
      if (result.error || result.status !== 0 || result.stderr?.trim()) {
        try { fs.rmSync(evidence, { force: true }); } catch {}
        throw new Error(`Complete packet/frame evidence failed: ${String(result.stderr || result.error || "missing exit").slice(-1000)}`);
      }
      evidenceCache.framehashes.set(key, evidence);
      yield* readEvidenceLines(evidence);
      return;
    }
  }
  const owned = fs.mkdtempSync(path.join(directory, ".av-evidence-"));
  try {
    const evidence = path.join(owned, "packets.framehash");
    const result = spawnSync(ffmpegPath, framehashArgs(file, selector, codec, evidence, nativeVideo),
      { encoding: "utf8", timeout: 900000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0 || result.stderr?.trim()) {
      throw new Error(`Complete packet/frame evidence failed: ${String(result.stderr || result.error || "missing exit").slice(-1000)}`);
    }
    yield* readEvidenceLines(evidence);
  } finally {
    fs.rmSync(owned, { recursive: true, force: true });
  }
}

module.exports = { framehash, framehashCacheKey, framehashToFileAsync };
