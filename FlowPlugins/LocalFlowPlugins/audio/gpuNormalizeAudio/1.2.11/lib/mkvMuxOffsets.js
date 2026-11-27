"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isMovieContainer } = require("./outputAudioSpecs");
const { mediaTools } = require("./mediaTools");
const { decoderIdentity } = require("./mediaEvidenceTools");
const { inspectMedia, inspectStreams } = require("./mediaSourceProbe");
const { probeAudioTimeline } = require("./mediaNativeAudioClock");

function firstAudioPacketPtsSeconds(ffprobeExec, file) {
  const out = execFileSync(ffprobeExec, [
    "-v", "error",
    "-select_streams", "a:0",
    "-read_intervals", "%+#1",
    "-show_entries", "packet=pts_time",
    "-of", "default=nw=1:nk=1",
    file,
  ], { encoding: "utf8", timeout: 30000 }).trim();
  const parsed = Number(out.split(/\r?\n/)[0]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rationalSeconds(value) {
  if (!value || value.denominator === 0n) return null;
  return Number(value.numerator) / Number(value.denominator);
}

function computeMkvNormalizedInputOffsets({ args, container, inputFile, audioSpecs = [] }) {
  const offsets = new Map();
  if (!inputFile || isMovieContainer(container) || !fs.existsSync(inputFile)) return offsets;
  const normalizedSpecs = (audioSpecs || []).filter(
    (spec) => spec.kind === "normalizedFile" && spec.plan?.normalizedAudio && fs.existsSync(spec.plan.normalizedAudio),
  );
  if (!normalizedSpecs.length) return offsets;

  const tools = mediaTools(args);
  const prober = decoderIdentity(tools.ffprobe);
  const ffprobeExec = (prober.native || prober).executable;
  const sourceInfo = inspectMedia(inputFile, ffprobeExec);
  const formatNames = String(sourceInfo.format?.format_name || "").split(",");
  if (!formatNames.includes("matroska") && !formatNames.includes("webm")) return offsets;

  const sourceAudio = inspectStreams(inputFile, ffprobeExec).filter((stream) => stream.type === "audio");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-mkv-offsets-"));
  try {
    const sourceStartByIndex = new Map();
    for (const spec of normalizedSpecs) {
      const sourceIdx = spec.plan.sourceAudioIdx;
      if (!Number.isSafeInteger(sourceIdx) || !sourceAudio[sourceIdx]) continue;
      if (!sourceStartByIndex.has(sourceIdx)) {
        const timeline = probeAudioTimeline(inputFile, sourceIdx, sourceAudio[sourceIdx], ffprobeExec, tmpDir, null);
        const startSec = rationalSeconds(timeline.segments?.[0]?.start);
        sourceStartByIndex.set(sourceIdx, startSec);
      }
      const srcStart = sourceStartByIndex.get(sourceIdx);
      if (!Number.isFinite(srcStart)) continue;
      const candFirstPts = firstAudioPacketPtsSeconds(ffprobeExec, spec.plan.normalizedAudio);
      const delta = srcStart - candFirstPts;
      if (Number.isFinite(delta) && Math.abs(delta) >= 0.0005) {
        offsets.set(spec.plan.normalizedAudio, delta.toFixed(6));
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return offsets;
}

module.exports = {
  computeMkvNormalizedInputOffsets,
};
