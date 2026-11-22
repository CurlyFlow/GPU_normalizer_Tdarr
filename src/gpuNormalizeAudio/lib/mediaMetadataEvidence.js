"use strict";

const assert = require("node:assert/strict");

const MKV_MP4_GENERATED_STREAM_TAG = /^(?:creation_time|encoder|handler_name|vendor_id|duration|bps|number_of_frames|number_of_bytes|_statistics_(?:writing_app|writing_date_utc|tags))(?:-[a-z]{2,3})?$/;

function tags(value, generated = [], pattern = null) {
  const result = {};
  for (const [raw, text] of Object.entries(value || {})) {
    const key = raw.toLowerCase();
    if (generated.includes(key) || (pattern && pattern.test(key))) continue;
    if (Object.hasOwn(result, key)) throw Error("Ambiguous metadata tag casing");
    result[key] = String(text);
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function rational(value, base) {
  if (!/^-?\d+$/.test(String(value)) || !/^\d+\/[1-9]\d*$/.test(base || "")) throw Error("Invalid chapter clock");
  const [numerator, denominator] = base.split("/").map(BigInt);
  return { numerator: BigInt(value) * numerator, denominator };
}

function sameTime(before, after, offset) {
  return (after.numerator * before.denominator - before.numerator * after.denominator) * BigInt(offset.denominator)
    === BigInt(offset.numerator) * before.denominator * after.denominator;
}

function verifyMetadataCarriers(before, after, offset) {
  // Only muxer-owned provenance/brand fields may regenerate. All custom tags,
  // chapter titles, order and exact presentation boundaries remain mandatory.
  const generated = ["encoder", "major_brand", "minor_version", "compatible_brands"];
  assert.deepEqual(tags(after.format?.tags, generated), tags(before.format?.tags, generated), "Global metadata changed");
  const source = before.chapters || [], candidate = after.chapters || [];
  if (!Array.isArray(source) || !Array.isArray(candidate) || source.length !== candidate.length) throw Error("Chapter coverage changed");
  source.forEach((chapter, index) => {
    const actual = candidate[index];
    assert.deepEqual(tags(actual.tags), tags(chapter.tags), "Chapter metadata changed");
    for (const key of ["start", "end"]) {
      if (!sameTime(rational(chapter[key], chapter.time_base), rational(actual[key], actual.time_base), offset)) {
        throw Error("Chapter presentation boundary changed");
      }
    }
  });
  return { status: "pass", chapters: source.length, globalTags: Object.keys(tags(before.format?.tags, generated)) };
}

function verifyDisposition(source, candidate, containerPromotion) {
  if (!containerPromotion) {
    assert.deepEqual(candidate.disposition, source.disposition, "Retained stream disposition changed");
    return;
  }
  const before = source.disposition || {}, after = candidate.disposition || {};
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), "Retained stream disposition changed");
  for (const key of Object.keys(before)) {
    if (after[key] === before[key]) continue;
    if (key === "default" && before[key] === 0 && after[key] === 1) continue;
    if (key === "captions" && before.hearing_impaired === 1 && before[key] === 0 && after[key] === 1) continue;
    throw Error("Retained stream disposition changed");
  }
}

function verifyStreamMetadata(source, candidate, transformed = false, options = {}) {
  const generated = transformed ? ["encoder"] : [];
  const pattern = options.containerPromotion ? MKV_MP4_GENERATED_STREAM_TAG : null;
  const before = tags(source.tags, generated, pattern), after = tags(candidate.tags, generated, pattern);
  // FFmpeg represents an unspecified language either as absent or `und`.
  before.language ||= "und";
  after.language ||= "und";
  assert.deepEqual(after, before, "Retained stream metadata changed");
  verifyDisposition(source, candidate, Boolean(options.containerPromotion));
}

function isSynthesizedAudioServiceSideData(source, candidate, containerPromotion) {
  return Boolean(containerPromotion && source.codec_type === "audio"
    && ["ac3", "eac3"].includes(source.codec_name)
    && !(source.side_data_list || []).length
    && Array.isArray(candidate.side_data_list) && candidate.side_data_list.length > 0
    && candidate.side_data_list.every(item => item?.side_data_type === "Audio Service Type"));
}

function verifyCopiedStreamProperties(source, candidate, options = {}) {
  const promotedSubtitle = options.containerPromotion && source.codec_type === "subtitle"
    && ["subrip", "ass"].includes(source.codec_name) && candidate.codec_name === "mov_text";
  const synthesizedAudioSideData = isSynthesizedAudioServiceSideData(source, candidate, options.containerPromotion);
  const properties = ["codec_type", ...(promotedSubtitle ? [] : ["codec_name"]), "profile", "width", "height", "pix_fmt", "sample_aspect_ratio", "field_order",
    "color_range", "color_space", "color_transfer", "color_primaries", "chroma_location",
    ...(synthesizedAudioSideData ? [] : ["side_data_list"]),
    "channels", "channel_layout", "sample_rate", "sample_fmt"];
  assert.deepEqual(properties.map(key => candidate[key] ?? null), properties.map(key => source[key] ?? null),
    "Copied stream native configuration or HDR carrier changed");
}

module.exports = { verifyMetadataCarriers, verifyStreamMetadata, verifyCopiedStreamProperties };
