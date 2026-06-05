"use strict";

const fs = require("fs");

const STATS_CACHE_MAGIC = "loudnorm-gpu-stats-cache-v1";

function readStatsCacheHeader(path) {
  const fd = fs.openSync(path, "r");
  try {
    const chunks = [];
    const buf = Buffer.alloc(4096);
    let bytesReadTotal = 0;
    while (bytesReadTotal < 1024 * 1024) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, bytesReadTotal);
      if (bytesRead <= 0) break;
      const readSlice = buf.subarray(0, bytesRead);
      const newlineIdx = readSlice.indexOf(10);
      if (newlineIdx !== -1) {
        chunks.push(readSlice.subarray(0, newlineIdx));
        const headerBytes = bytesReadTotal + newlineIdx + 1;
        return { header: JSON.parse(Buffer.concat(chunks).toString("utf8")), headerBytes };
      }
      chunks.push(readSlice);
      bytesReadTotal += bytesRead;
    }
    throw new Error("missing stats cache header newline");
  } finally {
    fs.closeSync(fd);
  }
}

function expectedStatsCacheBytes(headerBytes, header) {
  const windows = Number.parseInt(String(header.windows), 10);
  const stateBytes = Number.parseInt(String(header.state_bytes), 10);
  const sourceExactDoubles = Number.parseInt(String(header.source_exact_doubles || 0), 10);
  if (!(windows >= 0) || !(stateBytes >= 0) || !(sourceExactDoubles >= 0)) {
    throw new Error("invalid stats cache size fields");
  }
  return headerBytes + (windows * 8) + (windows * 4) + stateBytes + (sourceExactDoubles * 8);
}

function validateStatsCacheShape(header) {
  const windows = Number.parseInt(String(header.windows), 10);
  const stateBytes = Number.parseInt(String(header.state_bytes), 10);
  const totalFrames = Number.parseInt(String(header.total_frames), 10);
  const seconds = Number.parseFloat(String(header.seconds));
  if (!(windows > 0)) return { ok: false, reason: "no windows" };
  if (!(stateBytes > 0)) return { ok: false, reason: "no state" };
  if (!(totalFrames > 0)) return { ok: false, reason: "no frames" };
  if (!(seconds > 0)) return { ok: false, reason: "no duration" };
  return { ok: true };
}

function validateStatsCache(path, { rate, channels, inputFormat, outputFormat }) {
  if (!path || !fs.existsSync(path)) return { ok: false, reason: "missing" };
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile() || stat.size <= 0) return { ok: false, reason: "empty" };
    const { header, headerBytes } = readStatsCacheHeader(path);
    const expected = {
      magic: STATS_CACHE_MAGIC,
      rate,
      channels,
      input_format: inputFormat,
      output_format: outputFormat,
    };
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (header[key] !== expectedValue) {
        return { ok: false, reason: `${key} mismatch cache=${header[key]} expected=${expectedValue}` };
      }
    }
    const shape = validateStatsCacheShape(header);
    if (!shape.ok) return shape;
    const expectedBytes = expectedStatsCacheBytes(headerBytes, header);
    if (stat.size < expectedBytes) return { ok: false, reason: `short cache size=${stat.size} expected=${expectedBytes}` };
    return { ok: true, header, size: stat.size };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function validatePlanStatsCache(plan, statsSampleRate, statsCache) {
  return validateStatsCache(statsCache, {
    rate: statsSampleRate,
    channels: plan.channels,
    inputFormat: plan.rawInputFormat,
    outputFormat: plan.rawGpuFormat,
  });
}

module.exports = {
  validatePlanStatsCache,
  validateStatsCache,
};
