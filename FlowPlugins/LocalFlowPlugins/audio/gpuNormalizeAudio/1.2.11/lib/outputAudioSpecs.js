"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { isMp4Container, isRegeneratedChapterCarrier, shouldEncodeCopiedAudioForMp4 } = require("./audioChannelHelpers");

const MOVIE_CONTAINERS = new Set(["mp4", "m4v", "mov", "m4a", "ipod"]);
const MP4_CONVERTIBLE_SUBTITLE_CODECS = new Set(["subrip", "ass"]);
const MAX_MOVIE_SCALE = 2147483647n;
function clockGcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
function isMovieContainer(container) { return MOVIE_CONTAINERS.has(container); }

function exactMovieTimescale(denominators) {
  assert.ok(Array.isArray(denominators) && denominators.length > 0 && denominators.length <= 1024);
  let scale = 1n;
  for (const value of denominators) {
    assert.match(String(value), /^[1-9]\d{0,79}$/, "Invalid movie clock denominator");
    const denominator = BigInt(value);
    assert.ok(denominator <= MAX_MOVIE_SCALE, "Movie clock denominator exceeds native bounds");
    scale = scale / clockGcd(scale, denominator) * denominator;
    assert.ok(scale <= MAX_MOVIE_SCALE, "Exact movie clock exceeds native bounds");
  }
  return Number(scale);
}

// Matching Jellyfin AAC's ff_mpeg4audio_sample_rates: no codec-rate guess.
const AAC_MOVIE_TIMESCALE = exactMovieTimescale([
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
]);

function privateAacMovieArgs(outputPath, outputFormat = "") {
  const container = outputFormat || path.extname(outputPath).slice(1).toLowerCase();
  return isMovieContainer(container) ? ["-movie_timescale", String(AAC_MOVIE_TIMESCALE)] : [];
}

function movieClockDenominator(time) {
  assert.match(String(time?.numerator), /^-?\d{1,80}$/);
  assert.match(String(time?.denominator), /^[1-9]\d{0,79}$/);
  const n = BigInt(time.numerator), d = BigInt(time.denominator);
  return d / clockGcd(n < 0n ? -n : n, d);
}

function pushContainerCopyCodecs(args) {
  args.push("-c:v", "copy", "-c:s", "copy", "-c:t", "copy", "-c:d", "copy");
}

function pushAacEncodeArgs(args, audioIdx, audioBitrate) {
  args.push(`-c:a:${audioIdx}`, "aac", `-b:a:${audioIdx}`, audioBitrate);
}

function normalizedEncodeSpec(spec) {
  return spec.kind === "directNormalized" && spec.plan;
}

function directMuxInputFormatForPlan(plan) {
  return plan.rawGpuFormat;
}

function pushAudioCodec(args, audioIdx, { container, stream, audioBitrate }) {
  if (shouldEncodeCopiedAudioForMp4(container, stream)) {
    pushAacEncodeArgs(args, audioIdx, audioBitrate);
    return;
  }
  args.push(`-c:a:${audioIdx}`, "copy");
}

function sourceAudioSpec(plan, audioStreams) {
  return {
    kind: "source",
    mapArg: `0:a:${plan.sourceAudioIdx}`,
    language: plan.language,
    stream: audioStreams[plan.sourceIdx],
  };
}

function sourceStreamSpec(stream, idx) {
  return {
    kind: "source",
    mapArg: `0:a:${idx}`,
    language: null,
    stream,
  };
}

function normalizedFileSpec(plan, inputIndex) {
  return {
    kind: "normalizedFile",
    mapArg: `${inputIndex}:a:0`,
    language: plan.language,
    plan,
  };
}

function buildCopyOriginalAudioSpecs(audioStreams, audioPlansToCopy = null) {
  return Array.isArray(audioPlansToCopy)
    ? audioPlansToCopy.map((plan) => sourceAudioSpec(plan, audioStreams))
    : audioStreams.map(sourceStreamSpec);
}

function buildFinalAudioSpecs(audioPlans, skippedAudioPlans, audioStreams, gainSkipped = new Set()) {
  let inputIndex = 0;
  return [
    ...audioPlans.map(plan => gainSkipped.has(plan.idx) && !plan.stereoFallback
      ? sourceAudioSpec(plan, audioStreams) : normalizedFileSpec(plan, ++inputIndex)),
    ...skippedAudioPlans.map((plan) => sourceAudioSpec(plan, audioStreams)),
  ];
}

function directNormalizedSpec(plan, inputIndex, values) {
  return {
    kind: "directNormalized",
    mapArg: `${inputIndex}:a:0`,
    language: plan.language,
    plan,
    values,
  };
}

function encodedDirectNormalizedSpec(plan, inputIndex) {
  return {
    kind: "encodedDirectNormalized",
    mapArg: `${inputIndex}:a:0`,
    language: plan.language,
    plan,
  };
}

function pushBasePackageMaps(args, audioSpecs, { container, inputStreams = [] } = {}) {
  args.push("-map", "0:v?");
  audioSpecs.forEach((spec) => args.push("-map", spec.mapArg));
  args.push("-map", "0:s?", "-map", "0:t?", "-map", "0:d?", "-map_chapters", "0", "-map_metadata", "0");
  pushChapterCarrierExclusions(args, container, inputStreams);
}

function pushChapterCarrierExclusions(args, container, inputStreams) {
  if (isMp4Container(container)) {
    // MOV regenerates its text chapter carrier from -map_chapters. Copying that
    // carrier as arbitrary binary data can create an additional gpmd track.
    for (const stream of inputStreams) {
      if (isRegeneratedChapterCarrier(container, stream)) {
        if (!Number.isInteger(stream.index) || stream.index < 0) throw new Error("Invalid chapter carrier index");
        args.push("-map", `-0:${stream.index}`);
      }
    }
  }
}

function pushOutputAudioCodecs(args, audioSpecs, {
  audioBitrate,
  container,
  encodeSampleRateArgsFor = null,
  encodeThreadArgs = null,
}) {
  audioSpecs.forEach((spec, audioIdx) => {
    if (spec.kind === "normalizedFile") {
      args.push(`-c:a:${audioIdx}`, "copy");
      return;
    }
    if (spec.kind === "encodedDirectNormalized") {
      args.push(`-c:a:${audioIdx}`, "copy");
      return;
    }
    if (normalizedEncodeSpec(spec)) {
      const encodeRateArgs = encodeSampleRateArgsFor ? encodeSampleRateArgsFor(spec.plan, spec.values) : [];
      const codecThreadArgs = encodeThreadArgs ? encodeThreadArgs(spec.plan) : [];
      pushAacEncodeArgs(args, audioIdx, audioBitrate);
      if (encodeRateArgs[0] === "-ar" && encodeRateArgs[1]) args.push(`-ar:a:${audioIdx}`, encodeRateArgs[1]);
      if (codecThreadArgs[0] === "-threads" && codecThreadArgs[1]) args.push(`-threads:a:${audioIdx}`, codecThreadArgs[1]);
      return;
    }
    pushAudioCodec(args, audioIdx, {
      container,
      stream: spec.stream,
      audioBitrate,
    });
  });
}

function pushOutputAudioMetadata(args, audioSpecs, inputStreams) {
  const originalAudio = inputStreams.filter(stream => stream.codec_type === "audio");
  audioSpecs.forEach((spec, audioIdx) => {
    const source = spec.kind === "source" ? spec.stream : originalAudio[spec.plan.sourceAudioIdx];
    if (!source) throw new Error("Output audio metadata lacks its original stream");
    // Explicit tag assignments keep FFmpeg's automatic metadata copy for video,
    // subtitles and attachments. A per-stream -map_metadata disables it globally.
    for (const [key, value] of Object.entries(source.tags || {})) {
      if (key.toLowerCase() === "encoder") continue;
      if (!key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0")) {
        throw new Error("Source audio metadata cannot be represented safely");
      }
      args.push(`-metadata:s:a:${audioIdx}`, `${key}=${value}`);
    }
    if (spec.language) args.push(`-metadata:s:a:${audioIdx}`, `language=${spec.language}`);
    const flags = Object.entries(source.disposition || {});
    if (flags.some(([key, value]) => !/^[a-z0-9_]+$/.test(key) || ![0, 1].includes(value))) {
      throw new Error("Invalid original audio disposition");
    }
    args.push(`-disposition:a:${audioIdx}`, flags.filter(([, value]) => value === 1).map(([key]) => key).join("+") || "0");
  });
}

function pushMp4MetadataTagsArgs(args, container) {
  const normalized = String(container || "").toLowerCase();
  if (isMovieContainer(normalized)) {
    args.push("-movflags", "+use_metadata_tags");
  }
  // FFmpeg movenc.c requires strict_std_compliance <= FF_COMPLIANCE_UNOFFICIAL (-1)
  // for Dolby Vision (dvcC/dvvC/dvwC), Stereo3D and Spherical boxes in MP4,
  // and <= FF_COMPLIANCE_EXPERIMENTAL (-2) for TrueHD in MP4.
  if (isMp4Container(normalized)) {
    args.push("-strict", "-2");
  }
}

function pushMp4ConvertibleSubtitleArgs(args, streams) {
  let subtitleCount = 0;
  for (const stream of streams) {
    if (stream.codec_type !== "subtitle") continue;
    if (MP4_CONVERTIBLE_SUBTITLE_CODECS.has(stream.codec_name)) {
      // 1/1000s matches Matroska/SRT precision and avoids FFmpeg's default 1/1000000s
      // mov_text timescale overflowing 32-bit MP4 stts sample_delta at 35m47s.
      args.push(`-c:s:${subtitleCount}`, "mov_text", `-time_base:s:${subtitleCount}`, "1/1000");
    }
    subtitleCount += 1;
  }
  return subtitleCount;
}

function pushPreservedVideoTimescaleArgs(args, container, inputStreams = []) {
  if (!isMovieContainer(container)) return;
  const videos = inputStreams.filter((stream) => (stream.codec_type || stream.type) === "video");
  if (videos.length > 0 && videos.every((stream) => stream.time_base === "1/1000")) {
    args.push("-video_track_timescale", "1000");
  }
}

module.exports = {
  AAC_MOVIE_TIMESCALE,
  MP4_CONVERTIBLE_SUBTITLE_CODECS,
  exactMovieTimescale,
  isMovieContainer,
  movieClockDenominator,
  privateAacMovieArgs,
  buildCopyOriginalAudioSpecs,
  buildFinalAudioSpecs,
  directMuxInputFormatForPlan,
  directNormalizedSpec,
  encodedDirectNormalizedSpec,
  normalizedFileSpec,
  pushAacEncodeArgs,
  pushBasePackageMaps,
  pushChapterCarrierExclusions,
  pushContainerCopyCodecs,
  pushMp4ConvertibleSubtitleArgs,
  pushMp4MetadataTagsArgs,
  pushPreservedVideoTimescaleArgs,
  pushOutputAudioCodecs,
  pushOutputAudioMetadata,
  sourceAudioSpec,
  sourceStreamSpec,
};
