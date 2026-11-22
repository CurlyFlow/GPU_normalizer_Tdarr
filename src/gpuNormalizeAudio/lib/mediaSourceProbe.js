"use strict";

const { spawnSync } = require("node:child_process");

const BENIGN_MEDIA_DIAGNOSTICS = [
  /^\[mov,mp4,m4a,3gp,3g2,mj2 @ 0x[0-9a-f]+\] Referenced QT chapter track not found$/,
];

function unexpectedMediaDiagnostics(stderr) {
  return String(stderr || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !BENIGN_MEDIA_DIAGNOSTICS.some(pattern => pattern.test(line)))
    .join("\n");
}

function inspectMedia(file, executable) {
  const result = spawnSync(executable, ["-v", "error", "-analyzeduration", "30000000", "-probesize", "100000000",
    "-show_streams", "-show_format", "-show_chapters", "-of", "json", file],
  { encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0 || unexpectedMediaDiagnostics(result.stderr)) throw Error("Clock metadata inspection incomplete");
  const value = JSON.parse(result.stdout);
  if (!Array.isArray(value.streams) || !value.streams.length || value.streams.length > 256) throw Error("Invalid clock metadata");
  return value;
}

function inspectStreams(file, executable) {
  return inspectMedia(file, executable).streams.map(stream => ({ ...stream, type: stream.codec_type }));
}

module.exports = { inspectMedia, inspectStreams, unexpectedMediaDiagnostics };
