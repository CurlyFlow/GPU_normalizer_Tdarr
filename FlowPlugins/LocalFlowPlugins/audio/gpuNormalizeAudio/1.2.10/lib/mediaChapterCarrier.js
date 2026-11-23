"use strict";

const assert = require("node:assert/strict");
const { isRegeneratedChapterCarrier } = require("./audioChannelHelpers");
const { verifyMetadataCarriers } = require("./mediaMetadataEvidence");

function verifyChapterCarrier(before, after, source, candidate, offset) {
  const identified = (media, stream) => String(media.format?.format_name || "").split(",").includes("mov")
    && isRegeneratedChapterCarrier("mp4", stream);
  const original = identified(before, source), regenerated = identified(after, candidate);
  if (!original && !regenerated) return null;
  assert.ok(original && regenerated, "Regenerated chapter carrier changed its descriptor");
  for (const media of [before, after]) {
    assert.ok(Array.isArray(media.chapters) && media.chapters.length > 0, "Chapter carrier has no admitted chapters");
    assert.equal(media.streams.filter(stream => identified(media, stream)).length, 1, "Ambiguous chapter carrier coverage");
  }
  // MOV rebuilds this carrier from chapters; its demuxer may expose no packets.
  // Prove the complete decoded chapter table, not an empty packet comparison.
  verifyMetadataCarriers(before, after, offset);
  return { status: "pass", scope: "regenerated-mp4-chapters", chapters: before.chapters.length };
}

module.exports = { verifyChapterCarrier };
