"use strict";

const path = require("node:path");
const { isRegeneratedChapterCarrier } = require("./audioChannelHelpers");
const { canonicalMp4Language } = require("./mediaMetadataEvidence");
const { fileDigest } = require("./mediaEvidenceFiles");
const { validateReceipt } = require("./mediaClockProtocol");
const { inspectMedia } = require("./mediaSourceProbe");

function hasValidStreamCodec(stream) {
  if (typeof stream.codec_name === "string" && stream.codec_name.length > 0) return true;
  // FFprobe omits codec_name on Matroska attachments/data with AV_CODEC_ID_NONE (e.g. .nfo).
  return ["attachment", "data"].includes(stream.codec_type) && stream.codec_name === undefined;
}

function streams(file, requireCodecName = false) {
  const values = file.ffProbeData?.streams;
  if (!Array.isArray(values) || !values.length || values.length > 256
      || values.some(stream => !Number.isSafeInteger(stream.index) || stream.index < 0
        || typeof stream.codec_type !== "string"
        || (requireCodecName ? (typeof stream.codec_name !== "string" || !stream.codec_name.length) : !hasValidStreamCodec(stream)))
      || values.some((stream, index) => index > 0 && stream.index <= values[index - 1].index)
      || new Set(values.map(stream => stream.index)).size !== values.length) {
    throw Error("Preparation requires an exact, unambiguous stream inventory");
  }
  return values;
}

function language(stream, promotedMkv = false) {
  return promotedMkv
    ? canonicalMp4Language(stream.tags?.language)
    : String(stream.tags?.language || "und").toLowerCase();
}

function bindPreparationMap(source, prepared, retainedIndices, originalId) {
  const before = streams(source, false);
  const after = streams(prepared, true);
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
  const promotedMkv = path.extname(source._id).toLowerCase() === ".mkv"
    && path.extname(prepared._id).toLowerCase() === ".mp4";
  const comparableAfter = promotedMkv
    ? after.filter(stream => !isRegeneratedChapterCarrier("mp4", stream))
    : after;
  if (promotedMkv && comparableAfter.some((stream, index) => stream.index !== index)) {
    throw Error("Regenerated MP4 chapter carrier must be trailing");
  }
  if (selected.length !== comparableAfter.length) throw Error("Prepared stream count differs from its explicit selection");
  const mapping = selected.map((stream, index) => {
    const actual = comparableAfter[index];
    if (typeof stream.codec_name !== "string" || !stream.codec_name.length) {
      throw Error("Preparation requires an exact, unambiguous stream inventory");
    }
    const promotedSub = promotedMkv && stream.codec_type === "subtitle"
      && ["subrip", "ass"].includes(stream.codec_name) && actual.codec_name === "mov_text";
    if (actual.codec_type !== stream.codec_type || (!promotedSub && actual.codec_name !== stream.codec_name)
        || (["audio", "subtitle"].includes(stream.codec_type) && language(actual) !== language(stream, promotedMkv))
        || (stream.codec_type === "audio" && (actual.channels !== stream.channels
          || String(actual.sample_rate) !== String(stream.sample_rate)))) {
      throw Error("Prepared stream differs from its selected source identity");
    }
    return {
      type: stream.codec_type, codec: stream.codec_name,
      sourceIndex: stream.index,
      sourceOrdinal: before.filter(value => value.codec_type === stream.codec_type).indexOf(stream),
      preparedIndex: actual.index,
      preparedOrdinal: comparableAfter.filter(value => value.codec_type === actual.codec_type).indexOf(actual),
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

function preparationVideoMap(mapping) {
  return mapping.streams.filter(stream => stream.type === "video")
    .map(stream => ({ sourceIndex: stream.sourceOrdinal, candidateIndex: stream.preparedOrdinal }));
}

function requirePreparationEvidence(args, contract) {
  const mapping = requirePreparationMap(args, contract);
  const receipt = args.variables.mediaPipelinePreparationEvidence;
  const selected = mapping.streams.filter(stream => stream.type === "audio");
  if (!receipt || receipt.status !== "pass" || receipt.sourceFile !== mapping.originalId
      || receipt.candidateFile !== mapping.preparedId || !Array.isArray(receipt.audioMap)
      || receipt.audioMap.length !== selected.length || receipt.audioMap.some((map, index) => {
        const stream = selected[index];
        return map.id !== `prepare-a${index}` || map.sourceIndex !== stream.sourceOrdinal
          || map.candidateIndex !== stream.preparedOrdinal || map.compareSamples !== true || map.sampleBytes !== 8;
      })) throw Error("Missing or foreign preparation content/clock proof");
  validateReceipt(receipt, { sourceFile: mapping.originalId, candidateFile: mapping.preparedId,
    audioMap: receipt.audioMap, videoMap: preparationVideoMap(mapping) });
  return receipt;
}

function sourceClockTickForFile(file, ffprobeExec) {
  const media = inspectMedia(file, ffprobeExec);
  if (!String(media.format?.format_name || "").split(",").includes("matroska")) return null;
  const audio = media.streams.filter(stream => stream.codec_type === "audio");
  for (const stream of audio) {
    const match = String(stream.time_base || "").match(/^([1-9]\d{0,9})\/([1-9]\d{0,9})$/);
    const rate = Number(stream.sample_rate);
    if (match && Number.isSafeInteger(rate) && rate > 0 && BigInt(match[1]) * BigInt(rate) > BigInt(match[2])) {
      return { numerator: match[1], denominator: match[2] };
    }
  }
  return null;
}

function sourceClockTickForPreparation(args, ffprobeExec) {
  if (!args.variables?.mediaPipeline || !args.originalLibraryFile?._id || !args.inputFileObj?._id) return null;
  if (args.originalLibraryFile._id === args.inputFileObj._id) return null;
  requirePreparationEvidence(args, { originalId: args.originalLibraryFile._id, preparedId: args.inputFileObj._id });
  return sourceClockTickForFile(args.originalLibraryFile._id, ffprobeExec);
}

module.exports = {
  bindPreparationMap, requirePreparationMap, preparationVideoMap,
  requirePreparationEvidence, sourceClockTickForFile, sourceClockTickForPreparation,
};
