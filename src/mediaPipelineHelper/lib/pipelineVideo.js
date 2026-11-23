"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pushChapterCarrierExclusions } = require("./outputAudioSpecs");

function canonicalLanguage(value) {
  const language = String(value || "").toLowerCase();
  if (["de", "ger", "deu"].includes(language)) return "deu";
  if (["en", "eng"].includes(language)) return "eng";
  return language;
}

function selectedSidecars(original, settings, readdir = fs.readdirSync, lstat = fs.lstatSync) {
  const directory = path.dirname(original);
  const basename = path.basename(original, path.extname(original));
  const allowed = settings.languages.map(canonicalLanguage);
  const entries = readdir(directory);
  if (entries.length > 1000) throw new Error("Companion inventory exceeds its bound");
  return entries.sort().flatMap((name) => {
    if (!name.startsWith(`${basename}.`) || !name.toLowerCase().endsWith(".srt")) return [];
    const parts = name.slice(basename.length + 1, -4).toLowerCase().split(".").filter(Boolean);
    const forced = parts.includes("forced");
    if (forced && !settings.includeForced) return [];
    let language = parts.find((part) => ["de", "ger", "deu", "en", "eng"].includes(part));
    if (!language) {
      if (!settings.includeUntagged || !settings.defaultLanguage) return [];
      language = settings.defaultLanguage;
    }
    language = canonicalLanguage(language);
    if (!allowed.includes(language)) return [];
    const file = path.join(directory, name);
    const stat = lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Selected companion is not a regular file");
    return [{ file, language, forced }];
  });
}

function selectedVideoSidecars(original, settings, preparation) {
  const extracted = new Set((preparation?.subtitles || []).map(record => record.file));
  return selectedSidecars(original, settings).filter(sidecar => !extracted.has(sidecar.file));
}

function planVideo(file, settings, sidecars, encoder = { encoder: "hevc_nvenc", outputArgs: [] }) {
  const streams = file.ffProbeData.streams;
  const inputs = ["-i", file._id, ...sidecars.flatMap((s) => ["-sub_charenc", "UTF-8", "-f", "srt", "-i", s.file])];
  const outputs = ["-map", "0", "-map_metadata", "0", "-map_chapters", "0", "-c", "copy"];
  pushChapterCarrierExclusions(outputs, "mp4", streams);
  let videoIndex = 0;
  let matroskaVideoClock = false;
  for (const stream of streams) {
    if (stream.codec_type !== "video") continue;
    if (stream.time_base === "1/1000") matroskaVideoClock = true;
    if (stream.codec_name !== "hevc") {
      outputs.push(`-c:v:${videoIndex}`, encoder.encoder, `-qp:v:${videoIndex}`, String(settings.videoQuality),
        `-preset:v:${videoIndex}`, settings.videoPreset, ...(encoder.outputArgs || []));
      if (stream.time_base === "1/1000") outputs.push(`-fps_mode:v:${videoIndex}`, "passthrough", `-enc_time_base:v:${videoIndex}`, "-1");
    }
    videoIndex += 1;
  }
  if (matroskaVideoClock) outputs.push("-video_track_timescale", "1000");
  if (sidecars.length) {
    const retained = streams.filter(stream => stream.codec_type === "subtitle").length;
    sidecars.forEach((sidecar, index) => {
      const outputIndex = retained + index;
      outputs.push("-map", `${index + 1}:0`, `-metadata:s:s:${outputIndex}`, `language=${sidecar.language}`,
        `-metadata:s:s:${outputIndex}`, `title=${sidecar.language}${sidecar.forced ? " forced" : ""}`,
        `-disposition:s:${outputIndex}`, sidecar.forced ? "forced" : "0");
    });
  }
  if (sidecars.length || streams.some((s) => s.codec_type === "subtitle")) outputs.push("-c:s", "mov_text");
  outputs.push("-ignore_unknown", "-max_muxing_queue_size", "99999", "-strict", "-2");
  return { inputs, outputs, container: "mp4", label: "Preparing final video container and subtitle tracks" };
}

async function processVideo(args, settings, runtime, runPhase) {
  const sidecars = selectedVideoSidecars(args.originalLibraryFile._id, settings.sidecars,
    args.variables.mediaPipelinePreparationPlan);
  const convert = args.inputFileObj.ffProbeData.streams.some((s) => s.codec_type === "video" && s.codec_name !== "hevc");
  const encoder = convert ? await runtime.encoder(args) : undefined;
  const executeVerified = async (working, companions, selectedEncoder, resource) => await runPhase(resource, async () => {
    const result = await runtime.execute(working, planVideo(working.inputFileObj, settings, companions, selectedEncoder));
    return await runtime.verifyVideo(working, result, settings, companions, selectedEncoder);
  });
  const finished = await executeVerified(args, [], encoder, convert ? "gpu" : "cpu");
  if (!sidecars.length) return finished;
  try {
    return await executeVerified({ ...args, inputFileObj: finished }, sidecars, undefined, "cpu");
  } catch (error) {
    if (error.code === "PIPELINE_CANCELLED" || error.preserveMediaEvidence === true) throw error;
    const retained = await runPhase("cpu", () => runtime.probe(finished._id, finished));
    args.variables = { ...args.variables, gpuNormalizeAudioWarnings: [
      ...(args.variables.gpuNormalizeAudioWarnings || []), "subtitleEmbeddingFailed",
    ] };
    args.jobLog("Optional subtitle embedding failed; verified previous video output retained. Companion files remain in the package.");
    return retained;
  }
}

module.exports = { planVideo, processVideo, selectedSidecars, selectedVideoSidecars };
