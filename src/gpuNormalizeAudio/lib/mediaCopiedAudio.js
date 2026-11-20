"use strict";

const { spawn } = require("node:child_process");
const { nativePcmFormat, PcmFingerprint } = require("./mediaPcmEvidence");

function decodedFingerprint(executable, file, index, format) {
  return new Promise((resolve, reject) => {
    const fingerprint = new PcmFingerprint(format);
    const child = spawn(executable, ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1",
      "-xerror", "-i", file, "-map", `0:a:${index}`, "-vn", "-sn", "-dn",
      // This sink proves values only. Native AVFrame clocks have their own owner;
      // give the raw PCM writer monotonic timestamps without changing any sample.
      "-af", "asetpts=N/SR/TB", "-c:a", `pcm_${format}`, "-f", format, "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    let failure = null, escalation;
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
    child.stderr.on("data", () => stop("Copied audio decoder emitted diagnostics"));
    child.on("error", () => stop("Copied audio decoder could not start"));
    child.on("close", (code, signal) => {
      clearTimeout(deadline); clearTimeout(escalation);
      if (failure || signal || code !== 0) return reject(failure || Error("Copied audio decode incomplete"));
      const result = fingerprint.finish();
      if (!result.aligned || !result.finite || result.samples === 0) return reject(Error("Copied audio samples are empty, non-finite or unaligned"));
      return resolve(result);
    });
  });
}

async function verifyCopiedAudio({ sourceFile, candidateFile, sourceStreams, candidateStreams, audioMap, ffmpegPath }) {
  const original = sourceStreams.filter(stream => stream.type === "audio");
  const candidate = candidateStreams.filter(stream => stream.type === "audio");
  const results = [];
  for (const map of audioMap.filter(value => value.compareSamples)) {
    const evidence = { map_id: map.id, status: "held", errors: [] };
    try {
      const before = original[map.sourceIndex], after = candidate[map.candidateIndex];
      if (!before || !after || Number(before.channels) !== Number(after.channels)
          || Number(before.sample_rate) !== Number(after.sample_rate)) throw Error("Copied audio native channels/rate changed");
      const format = [nativePcmFormat(before), nativePcmFormat(after)].includes("f64le") ? "f64le" : "f32le";
      evidence.source = await decodedFingerprint(ffmpegPath, sourceFile, map.sourceIndex, format);
      evidence.candidate = await decodedFingerprint(ffmpegPath, candidateFile, map.candidateIndex, format);
      if (evidence.source.bytes !== evidence.candidate.bytes || evidence.source.sha256 !== evidence.candidate.sha256) {
        throw Error("Copied audio decoded samples changed");
      }
      evidence.status = "pass";
    } catch (error) { evidence.errors.push(error.message); }
    results.push(evidence);
  }
  return results;
}

module.exports = { verifyCopiedAudio };
