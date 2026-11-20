"use strict";

const path = require("node:path");
const { fileDigest } = require("./mediaEvidenceFiles");

function streams(file) {
  const values = file.ffProbeData?.streams;
  if (!Array.isArray(values) || !values.length || values.length > 256
      || values.some(stream => !Number.isSafeInteger(stream.index) || stream.index < 0
        || typeof stream.codec_type !== "string" || typeof stream.codec_name !== "string")
      || values.some((stream, index) => index > 0 && stream.index <= values[index - 1].index)
      || new Set(values.map(stream => stream.index)).size !== values.length) {
    throw Error("Preparation requires an exact, unambiguous stream inventory");
  }
  return values;
}

function language(stream) {
  return String(stream.tags?.language || "und").toLowerCase();
}

function bindPreparationMap(source, prepared, retainedIndices, originalId) {
  const before = streams(source);
  const after = streams(prepared);
  if (after.some((stream, index) => stream.index !== index)) {
    throw Error("Prepared stream indices are not canonical");
  }
  if (!Array.isArray(retainedIndices) || !retainedIndices.length
      || new Set(retainedIndices).size !== retainedIndices.length
      || retainedIndices.some(index => !before.some(stream => stream.index === index))) {
    throw Error("Preparation selection differs from the source stream inventory");
  }
  const selected = before.filter(stream => retainedIndices.includes(stream.index));
  if (selected.some((stream, index) => stream.index !== retainedIndices[index])) {
    throw Error("Preparation selection changes the source stream order");
  }
  if (selected.length !== after.length) throw Error("Prepared stream count differs from its explicit selection");
  const mapping = selected.map((stream, index) => {
    const actual = after[index];
    if (actual.codec_type !== stream.codec_type || actual.codec_name !== stream.codec_name
        || (["audio", "subtitle"].includes(stream.codec_type) && language(actual) !== language(stream))
        || (stream.codec_type === "audio" && (actual.channels !== stream.channels
          || String(actual.sample_rate) !== String(stream.sample_rate)))) {
      throw Error("Prepared stream differs from its selected source identity");
    }
    return {
      type: stream.codec_type, codec: stream.codec_name,
      sourceIndex: stream.index,
      sourceOrdinal: before.filter(value => value.codec_type === stream.codec_type).indexOf(stream),
      preparedIndex: actual.index,
      preparedOrdinal: after.filter(value => value.codec_type === actual.codec_type).indexOf(actual),
    };
  });
  return {
    schema: "media-preparation-map.v1", scope: "stream-mapping-only",
    originalId, sourceId: source._id, preparedId: prepared._id,
    streams: mapping, removedIndices: before.filter(stream => !retainedIndices.includes(stream.index)).map(stream => stream.index),
  };
}

function requirePreparationMap(args, contract) {
  const value = args.variables?.mediaPipelinePreparation;
  const keys = ["schema", "scope", "originalId", "sourceId", "preparedId", "streams", "removedIndices"];
  if (!value || Object.keys(value).sort().join() !== keys.sort().join()
      || value.schema !== "media-preparation-map.v1" || value.scope !== "stream-mapping-only"
      || value.originalId !== contract.originalId || value.preparedId !== contract.preparedId
      || ![value.sourceId, value.preparedId].every(name => typeof name === "string" && !name.includes("\0")
        && path.isAbsolute(name) && path.resolve(name) === name)
      || !Array.isArray(value.streams) || !value.streams.length || value.streams.length > 256
      || !Array.isArray(value.removedIndices) || value.removedIndices.length + value.streams.length > 256
      || value.streams.some(stream => Object.keys(stream).sort().join()
        !== "codec,preparedIndex,preparedOrdinal,sourceIndex,sourceOrdinal,type"
        || typeof stream.type !== "string" || typeof stream.codec !== "string"
        || ![stream.sourceIndex, stream.preparedIndex, stream.sourceOrdinal, stream.preparedOrdinal]
          .every(index => Number.isSafeInteger(index) && index >= 0))
      || new Set(value.streams.map(stream => stream.sourceIndex)).size !== value.streams.length
      || new Set(value.streams.map(stream => stream.preparedIndex)).size !== value.streams.length
      || value.removedIndices.some(index => !Number.isSafeInteger(index) || index < 0
        || value.streams.some(stream => stream.sourceIndex === index))
      || new Set(value.removedIndices).size !== value.removedIndices.length) {
    throw Error("Missing or foreign preparation stream mapping");
  }
  const ordinals = new Map();
  for (const [index, stream] of value.streams.entries()) {
    const previous = ordinals.get(stream.type);
    if (stream.preparedIndex !== index || stream.preparedOrdinal !== (previous?.preparedOrdinal ?? -1) + 1
        || stream.sourceOrdinal <= (previous?.sourceOrdinal ?? -1) || stream.sourceOrdinal > stream.sourceIndex
        || (index > 0 && stream.sourceIndex <= value.streams[index - 1].sourceIndex)) {
      throw Error("Preparation stream mapping has inconsistent ordinals");
    }
    ordinals.set(stream.type, stream);
  }
  if (value.sourceId !== value.originalId) {
    let equivalent = false;
    try {
      const original = fileDigest(value.originalId), working = fileDigest(value.sourceId);
      equivalent = original.bytes === working.bytes && original.sha256 === working.sha256;
    } catch { /* Missing or unsafe files cannot prove original equivalence. */ }
    if (!equivalent) {
      throw Object.assign(Error("Repaired input has no admitted-original content equivalence proof; original retained"),
        { code: "MEDIA_PREPARATION_HELD", preserveMediaEvidence: true });
    }
  }
  return value;
}

module.exports = { bindPreparationMap, requirePreparationMap };
