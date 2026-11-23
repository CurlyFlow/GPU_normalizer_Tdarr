"use strict";

const { spawn } = require("node:child_process");
const { nativePcmFormat, PcmFingerprint } = require("./mediaPcmEvidence");
const { framehash } = require("./mediaFrameEvidence");
const { comparePacketPayloads } = require("./mediaClockEvidence");
const { unexpectedMediaDiagnostics } = require("./mediaSourceProbe");

function decodedFingerprint(executable, file, index, format, channels) {
  return new Promise((resolve, reject) => {
    const fingerprint = new PcmFingerprint(format);
    const child = spawn(executable, ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1",
      "-xerror", "-i", file, "-map", `0:a:${index}`, "-vn", "-sn", "-dn",
      ...(Number.isSafeInteger(channels) && channels > 0 ? ["-ac", String(channels)] : []),
      // Raw PCM sink proves decoded sample values without muxer timestamp state
      // so mid-stream broadcast channel switches cannot reset filtergraph PTS.
      "-c:a", `pcm_${format}`, "-f", format, "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    let failure = null, escalation, stderr = "";
    const stop = message => {
      if (failure) return;
      failure = Error(message);
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    const deadline = setTimeout(() => stop("Copied audio decode deadline exceeded"), 900000);
    child.stdout.on("data", chunk => {
      if (failure) return;
      try { fingerprint.update(chunk); } catch (error) { stop(error.message); }
    });
    child.stderr.on("data", chunk => {
      if (stderr.length < 16384) stderr += chunk.toString("utf8");
      if (stderr.includes("\n") && unexpectedMediaDiagnostics(stderr)) stop("Copied audio decoder emitted diagnostics");
    });
    child.on("error", () => stop("Copied audio decoder could not start"));
    child.on("close", (code, signal) => {
      clearTimeout(deadline); clearTimeout(escalation);
      if (!failure && unexpectedMediaDiagnostics(stderr)) failure = Error("Copied audio decoder emitted diagnostics");
      if (failure || signal || code !== 0) return reject(failure || Error("Copied audio decode incomplete"));
      const result = fingerprint.finish();
      if (!result.aligned || !result.finite || result.samples === 0) return reject(Error("Copied audio samples are empty, non-finite or unaligned"));
      return resolve(result);
    });
  });
}

async function verifyCopiedAudio({ sourceFile, candidateFile, sourceStreams, candidateStreams, audioMap, ffmpegPath, directory = null, evidenceCache = null }) {
  const original = sourceStreams.filter(stream => stream.type === "audio");
  const candidate = candidateStreams.filter(stream => stream.type === "audio");
  return await Promise.all(audioMap.filter(value => value.compareSamples).map(async map => {
    const evidence = { map_id: map.id, status: "held", errors: [] };
    try {
      const before = original[map.sourceIndex], after = candidate[map.candidateIndex];
      if (!before || !after || Number(before.channels) !== Number(after.channels)
          || Number(before.sample_rate) !== Number(after.sample_rate)) throw Error("Copied audio native channels/rate changed");
      const format = [nativePcmFormat(before), nativePcmFormat(after)].includes("f64le") ? "f64le" : "f32le";
      const channels = Number(before.channels);
      const [sourceOutcome, candOutcome] = await Promise.allSettled([
        decodedFingerprint(ffmpegPath, sourceFile, map.sourceIndex, format, channels),
        decodedFingerprint(ffmpegPath, candidateFile, map.candidateIndex, format, channels),
      ]);
      if (sourceOutcome.status === "rejected" && before.codec_name === after.codec_name && directory
          && /Copied audio decoder emitted diagnostics|Copied audio decode incomplete/.test(sourceOutcome.reason?.message || "")) {
        const copied = comparePacketPayloads(
          framehash(sourceFile, `0:a:${map.sourceIndex}`, "copy", ffmpegPath, directory, null, evidenceCache),
          framehash(candidateFile, `0:a:${map.candidateIndex}`, "copy", ffmpegPath, directory, null, evidenceCache));
        evidence.packetCopyFallback = true;
        evidence.packets = copied.packets;
        evidence.status = "pass";
        return evidence;
      }
      if (sourceOutcome.status === "rejected") throw sourceOutcome.reason;
      if (candOutcome.status === "rejected") throw candOutcome.reason;
      evidence.source = sourceOutcome.value;
      evidence.candidate = candOutcome.value;
      if (evidence.source.bytes !== evidence.candidate.bytes || evidence.source.sha256 !== evidence.candidate.sha256) {
        throw Error("Copied audio decoded samples changed");
      }
      evidence.status = "pass";
    } catch (error) { evidence.errors.push(error.message); }
    return evidence;
  }));
}

module.exports = { verifyCopiedAudio };
