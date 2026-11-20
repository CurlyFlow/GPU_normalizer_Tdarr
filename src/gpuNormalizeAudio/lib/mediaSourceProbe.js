"use strict";

const { spawnSync } = require("node:child_process");

function inspectMedia(file, executable) {
  const result = spawnSync(executable, ["-v", "error", "-show_streams", "-show_format", "-show_chapters", "-of", "json", file],
    { encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0 || result.stderr?.trim()) throw Error("Clock metadata inspection incomplete");
  const value = JSON.parse(result.stdout);
  if (!Array.isArray(value.streams) || !value.streams.length || value.streams.length > 256) throw Error("Invalid clock metadata");
  return value;
}

function inspectStreams(file, executable) {
  return inspectMedia(file, executable).streams.map(stream => ({ ...stream, type: stream.codec_type }));
}

module.exports = { inspectMedia, inspectStreams };
