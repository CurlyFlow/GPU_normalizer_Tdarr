"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { recoverInput } = require("./pipelineInputRecovery");
const { bindPreparationMap } = require("./pipelinePreparationMap");
const { bindSubtitleExtractions } = require("./pipelineSubtitleEvidence");
const { pushChapterCarrierExclusions, pushMp4MetadataTagsArgs } = require("./outputAudioSpecs");
const { isRegeneratedChapterCarrier } = require("./audioChannelHelpers");
const { canonicalMp4Language } = require("./mediaMetadataEvidence");

function isDescriptive(stream, includeSdh) {
  const title = String(stream.tags?.title || "").toLowerCase();
  return title.includes("commentary") || title.includes("description") || (includeSdh && title.includes("sdh"));
}

function hasUnwantedLanguage(stream, languages) {
  const language = stream.tags?.language;
  return typeof language === "string" && !languages.includes(language.toLowerCase());
}

function extractionTarget(original, stream) {
  const language = String(stream.tags?.language || "");
  if (!/^[a-zA-Z0-9-]*$/.test(language)) throw new Error("Subtitle language cannot form a safe companion name");
  const kind = stream.disposition?.hearing_impaired ? ".sdh" : (stream.disposition?.forced ? ".forced" : "");
  const extension = path.extname(original);
  return `${original.slice(0, -extension.length)}.${language}${kind}.srt`;
}

const MP4_COPYABLE_VIDEO = new Set(["hevc", "h264", "mpeg4", "av1", "vp9", "mpeg2video"]);
const MP4_COPYABLE_AUDIO = new Set(["aac", "ac3", "eac3", "dts", "mp3", "flac", "opus", "truehd"]);
const MP4_STRICT_AUDIO = new Set(["truehd", "opus", "flac"]);
const MP4_CONVERTIBLE_SUBS = new Set(["subrip", "ass"]);
const MP4_COPYABLE_SUBS = new Set(["mov_text", "dvd_subtitle"]);

function canPromoteMkvToMp4(file, retained) {
  if (String(file.container || "").toLowerCase() !== "mkv") return false;
  return retained.every(stream => {
    if (stream.codec_type === "video") return MP4_COPYABLE_VIDEO.has(stream.codec_name);
    if (stream.codec_type === "audio") return MP4_COPYABLE_AUDIO.has(stream.codec_name);
    if (stream.codec_type === "subtitle") {
      return MP4_COPYABLE_SUBS.has(stream.codec_name) || MP4_CONVERTIBLE_SUBS.has(stream.codec_name);
    }
    return false;
  });
}

function sourceVideoTimescale(retained) {
  for (const stream of retained) {
    if (stream.codec_type !== "video") continue;
    const match = String(stream.time_base || "").match(/^1\/([1-9]\d{0,9})$/);
    if (match && Number(match[1]) > 0 && Number(match[1]) <= 1000000) return match[1];
  }
  return null;
}

function planPreparation(file, original, settings, exists = fs.existsSync) {
  const streams = file.ffProbeData?.streams;
  if (!Array.isArray(streams) || streams.length === 0) {
    throw new Error("Media stream metadata is unavailable; refresh the probe before preparation");
  }
  const subtitles = streams.filter((s) => s.codec_type === "subtitle"
    && !settings.removeSubtitleCodecs.includes(s.codec_name)
    && !hasUnwantedLanguage(s, settings.keepLanguages)
    && !(settings.removeCommentary && isDescriptive(s, settings.removeSdh)));
  const extractable = subtitles.filter((s) => s.codec_name === "subrip");
  const targets = new Map();
  for (const stream of extractable) {
    if (isDescriptive(stream, false)) continue;
    const target = extractionTarget(original, stream);
    if (!targets.has(target)) targets.set(target, stream.index);
  }
  const audio = streams.filter((s) => s.codec_type === "audio");
  const keptAudio = audio.filter((s) => !hasUnwantedLanguage(s, settings.keepLanguages)
    && !(settings.removeCommentary && isDescriptive(s, true)));
  const keep = new Set([...subtitles,
    ...(keptAudio.length ? keptAudio : audio)].map((s) => s.index));
  const removed = streams.filter((s) => {
    if (["audio", "subtitle"].includes(s.codec_type)) return !keep.has(s.index);
    if (isRegeneratedChapterCarrier(file.container, s)) return false;
    return ["attachment", "data"].includes(s.codec_type)
      || ["none", "png", "bmp", "mjpeg"].includes(s.codec_name)
      || Number(s.disposition?.attached_pic) === 1;
  });
  const retained = streams.filter(stream => !removed.includes(stream));
  const promoteMp4 = canPromoteMkvToMp4(file, retained);
  const container = promoteMp4 ? "mp4" : file.container;
  const outputs = ["-map", "0", ...removed.flatMap((s) => ["-map", `-0:${s.index}`]),
    "-map_metadata", "0", "-map_chapters", "0", "-c", "copy"];
  pushChapterCarrierExclusions(outputs, container, streams);
  if (promoteMp4) {
    let videoOrdinal = 0;
    for (const stream of retained) {
      if (stream.codec_type !== "video") continue;
      if (stream.codec_name === "hevc") outputs.push(`-tag:v:${videoOrdinal}`, "hvc1");
      videoOrdinal += 1;
    }
    if (retained.some(stream => stream.codec_type === "subtitle" && MP4_CONVERTIBLE_SUBS.has(stream.codec_name))) {
      outputs.push("-c:s", "mov_text");
    }
    const videoScale = sourceVideoTimescale(retained);
    if (videoScale) outputs.push("-video_track_timescale", videoScale);
    if (retained.some(stream => stream.codec_type === "audio" && MP4_STRICT_AUDIO.has(stream.codec_name))) {
      outputs.push("-strict", "-2");
    }
    retained.forEach((stream, outputIndex) => {
      const rawLang = stream.tags?.language;
      if (typeof rawLang !== "string" || !rawLang.trim()) return;
      const normalized = canonicalMp4Language(rawLang);
      if (normalized !== rawLang.trim().toLowerCase()) {
        outputs.push(`-metadata:s:${outputIndex}`, `language=${normalized}`);
      }
    });
  }
  pushMp4MetadataTagsArgs(outputs, container);
  const extractions = [...targets].filter(([target]) => !exists(target));
  const remuxRequired = removed.length > 0 || promoteMp4;
  return { changed: remuxRequired || extractions.length > 0, remuxRequired, container, outputs,
    retainedStreamIndices: retained.map(stream => stream.index),
    subtitleTargets: [...targets].map(([file, sourceIndex]) => ({ sourceIndex, file })),
    extraOutputs: extractions.flatMap(([target, index]) => ["-map", `0:${index}`, "-c:s", "srt", target]) };
}

async function prepareMedia(args, settings, runtime) {
  delete args.variables.mediaPipelinePreparation;
  delete args.variables.mediaPipelinePreparationEvidence;
  delete args.variables.mediaPipelinePreparationPlan;
  delete args.variables.mediaPipelinePreparationIntent;
  args.inputFileObj = await recoverInput(args, runtime);
  const source = args.inputFileObj;
  const plan = planPreparation(args.inputFileObj, args.originalLibraryFile._id, settings);
  let extractionFailed = false;
  for (let offset = 0; offset < plan.extraOutputs.length; offset += 5) {
    try {
      await runtime.extractSubtitle(args, plan.extraOutputs[offset + 1], plan.extraOutputs[offset + 4]);
    } catch (error) {
      if (error.code === "PIPELINE_CANCELLED") throw error;
      extractionFailed = true;
    }
  }
  if (extractionFailed) {
    args.inputFileObj = await runtime.probe(args.inputFileObj._id, args.inputFileObj);
    args.variables = { ...args.variables, gpuNormalizeAudioWarnings: [
      ...(args.variables.gpuNormalizeAudioWarnings || []), "subtitleExtractionFailed",
    ] };
    args.jobLog("Optional subtitle extraction failed; permitted embedded subtitles retained for final processing.");
  }
  const subtitles = bindSubtitleExtractions(plan.subtitleTargets, extractionFailed);
  const prepared = plan.remuxRequired ? await runtime.execute(args, {
    label: "Preparing selected streams and subtitle companions", container: plan.container,
    inputs: ["-i", args.inputFileObj._id], outputs: plan.outputs }) : args.inputFileObj;
  args.variables.mediaPipelinePreparation = bindPreparationMap(source, prepared,
    plan.retainedStreamIndices, args.originalLibraryFile._id);
  args.variables.mediaPipelinePreparationPlan = { sourceId: source._id, extractionFailed, subtitles };
  return prepared;
}

module.exports = { planPreparation, prepareMedia };
