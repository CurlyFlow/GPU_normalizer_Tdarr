"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readEvidenceLines } = require("./mediaEvidenceFiles");

// Isolated verification worker only. Evidence remains streamed and privately owned.
function* framehash(file, selector, codec, ffmpegPath, directory, nativeVideo = null) {
  const owned = fs.mkdtempSync(path.join(directory, ".av-evidence-"));
  try {
    const evidence = path.join(owned, "packets.framehash");
    const video = nativeVideo ? ["-threads", "1", "-fps_mode", "passthrough", "-pix_fmt", nativeVideo.pix_fmt,
      "-enc_time_base", nativeVideo.time_base] : [];
    const result = spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-threads", "1",
      "-filter_threads", "1", "-filter_complex_threads", "1", "-xerror", "-copyts", "-i", file,
      "-map", selector, "-c", codec, ...video, "-f", "framehash", evidence],
    { encoding: "utf8", timeout: 900000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0 || result.stderr?.trim()) {
      throw new Error(`Complete packet/frame evidence failed: ${String(result.stderr || result.error || "missing exit").slice(-1000)}`);
    }
    yield* readEvidenceLines(evidence);
  } finally {
    fs.rmSync(owned, { recursive: true, force: true });
  }
}

module.exports = { framehash };
