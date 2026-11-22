"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { isMovieContainer, AAC_MOVIE_TIMESCALE, pushOutputAudioMetadata } = require("./outputAudioSpecs");
const { mediaTools } = require("./mediaTools");
const { decoderIdentity } = require("./mediaEvidenceTools");
const { inspectMedia, inspectStreams } = require("./mediaSourceProbe");
const { probeAudioTimelineAsync } = require("./mediaNativeAudioClock");
const { audioPresentation } = require("./mediaAudioWindow");
const { planAacClock, encodeClockPlan } = require("./audioClockPlan");
const { sourceClockTickForPreparation } = require("./pipelinePreparationMap");

function runProcessAsync(executable, argv, timeoutMs = 900000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(executable)} timed out`));
    }, timeoutMs);
    child.stdout.on("data", chunk => { if (stdout.length < 4096) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { if (stderr.length < 4096) stderr += chunk.toString("utf8"); });
    child.on("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function buildAudioBundleArgs(audioSpecs, inputStreams, bundlePath) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y"];
  for (const spec of audioSpecs) args.push("-i", spec.plan.normalizedAudio);
  audioSpecs.forEach((_, idx) => args.push("-map", `${idx}:a:0`));
  args.push("-c:a", "copy");
  pushOutputAudioMetadata(args, audioSpecs, inputStreams);
  args.push("-movie_timescale", String(AAC_MOVIE_TIMESCALE), bundlePath);
  return args;
}

function timelineNeedsClockMux(timeline) {
  return timeline.segments.length > 1 || timeline.segments[0].start.numerator !== 0n;
}

async function tryDirectClockFinalMux({
  args,
  container,
  inputFile,
  inputStreams,
  audioSpecs,
  tmpOutputFilePath,
}) {
  if (process.env.LOUDNORM_GPU_DIRECT_CLOCK_MUX === "0") return { used: false };
  if (!inputFile || !isMovieContainer(container)) return { used: false };
  if (!Array.isArray(audioSpecs) || audioSpecs.length === 0
      || !audioSpecs.every(spec => spec.kind === "normalizedFile" && spec.plan?.normalizedAudio)) {
    return { used: false };
  }
  const carrierPath = path.resolve(__dirname, "../runtime/bin/audio_clock_mux");
  if (!fs.existsSync(carrierPath)) return { used: false };

  const startedAt = Date.now();
  const tools = mediaTools(args);
  const decoder = decoderIdentity(tools.ffmpeg);
  const prober = decoderIdentity(tools.ffprobe);
  const ffmpegExec = (decoder.native || decoder).executable;
  const ffprobeExec = (prober.native || prober).executable;
  const sourceTickRaw = sourceClockTickForPreparation(args, ffprobeExec);
  const sourceTick = sourceTickRaw
    ? { numerator: BigInt(sourceTickRaw.numerator), denominator: BigInt(sourceTickRaw.denominator) } : null;

  const workDir = fs.mkdtempSync(path.join(path.dirname(tmpOutputFilePath), ".clock-final-mux-"));
  try {
    const sourceInfo = inspectMedia(inputFile, ffprobeExec);
    const formatNames = String(sourceInfo.format?.format_name || "").split(",");
    if (!formatNames.includes("mov")) return { used: false };
    if ((sourceInfo.streams || []).some(stream => Number(stream.disposition?.attached_pic) === 1)) {
      return { used: false };
    }
    const sourceStreams = inspectStreams(inputFile, ffprobeExec);
    const sourceAudio = sourceStreams.filter(stream => stream.type === "audio");
    const uniqueSourceIndices = [...new Set(audioSpecs.map(spec => spec.plan.sourceAudioIdx))];
    if (uniqueSourceIndices.some(idx => !sourceAudio[idx])) return { used: false };

    const bundlePath = path.join(workDir, "audio-bundle.mp4");
    const probeSourceTask = Promise.all(uniqueSourceIndices.map(async idx => {
      const timeline = await probeAudioTimelineAsync(inputFile, idx, sourceAudio[idx], ffprobeExec, workDir, sourceTick);
      return [idx, timeline];
    }));
    const buildAndProbeBundleTask = (async () => {
      const bundleRes = await runProcessAsync(ffmpegExec, buildAudioBundleArgs(audioSpecs, inputStreams, bundlePath));
      if (bundleRes.signal || bundleRes.code !== 0) {
        throw new Error(`Audio bundle mux failed: ${bundleRes.stderr.trim()}`);
      }
      const bundleStreams = inspectStreams(bundlePath, ffprobeExec);
      const bundleAudio = bundleStreams.filter(stream => stream.type === "audio");
      if (bundleAudio.length !== audioSpecs.length || bundleAudio.some(stream => stream.codec_name !== "aac")) {
        throw new Error("Audio bundle did not produce complete AAC streams");
      }
      const presentation = audioPresentation(bundlePath);
      if (presentation.tracks.length !== bundleAudio.length) {
        throw new Error("Audio bundle presentation track count mismatch");
      }
      const timelines = await Promise.all(bundleAudio.map((stream, idx) =>
        probeAudioTimelineAsync(bundlePath, idx, stream, ffprobeExec, workDir, null)));
      return { presentation, timelines };
    })();

    const [sourceEntries, bundle] = await Promise.all([probeSourceTask, buildAndProbeBundleTask]);
    const sourceTimelines = new Map(sourceEntries);
    if (![...sourceTimelines.values()].some(timelineNeedsClockMux)) {
      return { used: false };
    }

    const zeroOffset = { numerator: 0n, denominator: 1n };
    const plans = audioSpecs.map((spec, idx) => {
      const sourceTimeline = sourceTimelines.get(spec.plan.sourceAudioIdx);
      const candTimeline = bundle.timelines[idx];
      const window = bundle.presentation.tracks[idx];
      return {
        streamIndex: idx,
        plan: planAacClock(sourceTimeline, candTimeline, zeroOffset),
        durationRuns: window.durationRuns,
        declaredEnd: window.declaredEnd,
      };
    });

    const planPath = path.join(workDir, "clock.txt");
    fs.writeFileSync(planPath, encodeClockPlan(plans), { flag: "wx", mode: 0o600 });
    fs.rmSync(tmpOutputFilePath, { force: true });
    const muxRes = await runProcessAsync(carrierPath, ["--mux-audio", bundlePath, inputFile, tmpOutputFilePath, planPath]);
    if (muxRes.signal || muxRes.code !== 0 || muxRes.stdout) {
      fs.rmSync(tmpOutputFilePath, { force: true });
      return { used: false, reason: muxRes.stderr.trim() || `exit ${muxRes.code}` };
    }
    return { used: true, wallSec: (Date.now() - startedAt) / 1000 };
  } catch (err) {
    fs.rmSync(tmpOutputFilePath, { force: true });
    return { used: false, reason: String(err?.message || err).slice(0, 200) };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = {
  tryDirectClockFinalMux,
  timelineNeedsClockMux,
};
