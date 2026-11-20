"use strict";

const assert = require("node:assert/strict");

function tags(value, generated = []) {
  const result = {};
  for (const [raw, text] of Object.entries(value || {})) {
    const key = raw.toLowerCase();
    if (generated.includes(key)) continue;
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

function verifyStreamMetadata(source, candidate, transformed = false) {
  const before = tags(source.tags, transformed ? ["encoder"] : []), after = tags(candidate.tags, transformed ? ["encoder"] : []);
  // FFmpeg represents an unspecified language either as absent or `und`.
  before.language ||= "und";
  after.language ||= "und";
  assert.deepEqual(after, before, "Retained stream metadata changed");
  assert.deepEqual(candidate.disposition, source.disposition, "Retained stream disposition changed");
}

function verifyCopiedStreamProperties(source, candidate) {
  const properties = ["codec_type", "codec_name", "profile", "width", "height", "pix_fmt", "sample_aspect_ratio", "field_order",
    "color_range", "color_space", "color_transfer", "color_primaries", "chroma_location", "side_data_list",
    "channels", "channel_layout", "sample_rate", "sample_fmt"];
  assert.deepEqual(properties.map(key => candidate[key] ?? null), properties.map(key => source[key] ?? null),
    "Copied stream native configuration or HDR carrier changed");
}

module.exports = { verifyMetadataCarriers, verifyStreamMetadata, verifyCopiedStreamProperties };
