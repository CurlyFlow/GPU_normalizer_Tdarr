"use strict";

const assert = require("node:assert/strict");

// Complete ISO-639-1 -> ISO-639-2/T table from FFmpeg libavformat/avlanguage.c.
const ISO639_1_TO_2 = Object.fromEntries((
  "aa:aar ab:abk ae:ave af:afr ak:aka am:amh an:arg ar:ara as:asm av:ava ay:aym az:aze ba:bak be:bel bg:bul bh:bih bi:bis bm:bam bn:ben bo:bod br:bre bs:bos "
  + "ca:cat ce:che ch:cha co:cos cr:cre cs:ces cu:chu cv:chv cy:cym da:dan de:deu dv:div dz:dzo ee:ewe el:ell en:eng eo:epo es:spa et:est eu:eus fa:fas ff:ful "
  + "fi:fin fj:fij fo:fao fr:fra fy:fry ga:gle gd:gla gl:glg gn:grn gu:guj gv:glv ha:hau he:heb hi:hin ho:hmo hr:hrv ht:hat hu:hun hy:hye hz:her ia:ina id:ind "
  + "ie:ile ig:ibo ii:iii ik:ipk in:ind io:ido is:isl it:ita iu:iku iw:heb ja:jpn ji:yid jv:jav jw:jav ka:kat kg:kon ki:kik kj:kua kk:kaz kl:kal km:khm kn:kan "
  + "ko:kor kr:kau ks:kas ku:kur kv:kom kw:cor ky:kir la:lat lb:ltz lg:lug li:lim ln:lin lo:lao lt:lit lu:lub lv:lav mg:mlg mh:mah mi:mri mk:mkd ml:mal mn:mon "
  + "mo:ron mr:mar ms:msa mt:mlt my:mya na:nau nb:nob nd:nde ne:nep ng:ndo nl:nld nn:nno no:nor nr:nbl nv:nav ny:nya oc:oci oj:oji om:orm or:ori os:oss pa:pan "
  + "pi:pli pl:pol ps:pus pt:por qu:que rm:roh rn:run ro:ron ru:rus rw:kin sa:san sc:srd sd:snd se:sme sg:sag si:sin sk:slk sl:slv sm:smo sn:sna so:som sq:sqi "
  + "sr:srp ss:ssw st:sot su:sun sv:swe sw:swa ta:tam te:tel tg:tgk th:tha ti:tir tk:tuk tl:tgl tn:tsn to:ton tr:tur ts:tso tt:tat tw:twi ty:tah ug:uig uk:ukr "
  + "ur:urd uz:uzb ve:ven vi:vie vo:vol wa:wln wo:wol xh:xho yi:yid yo:yor za:zha zh:zho zu:zul"
).split(" ").map(pair => pair.split(":")));

const MKV_MP4_GENERATED_STREAM_TAG = /^(?:creation_time|encoder|handler_name|vendor_id)$/;
// Dispositions absent from FFmpeg libavformat/isom.c dash_role_map have no ISO MP4 carrier.
const MP4_UNREPRESENTABLE_DISPOSITIONS = new Set([
  "original", "clean_effects", "lyrics", "karaoke", "non_diegetic",
  "metadata", "dependent", "still_image", "multilayer", "timed_thumbnails",
]);

function canonicalMp4Language(value) {
  const primary = String(value || "").trim().toLowerCase().split(/[-_]/)[0];
  if (!primary) return "und";
  if (/^[a-z]{3}$/.test(primary)) return primary;
  return ISO639_1_TO_2[primary] || "und";
}

function isMkvToMp4Promotion(before, after) {
  return String(before?.format?.format_name || "").split(",").includes("matroska")
    && String(after?.format?.format_name || "").split(",").includes("mov");
}

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

function sameTimeWithin(before, after, offset, toleranceNum, toleranceDen) {
  const diffNum = (after.numerator * before.denominator - before.numerator * after.denominator) * BigInt(offset.denominator)
    - BigInt(offset.numerator) * before.denominator * after.denominator;
  const absDiff = diffNum < 0n ? -diffNum : diffNum;
  const denom = before.denominator * after.denominator * BigInt(offset.denominator);
  return absDiff * toleranceDen <= toleranceNum * denom;
}

function verifyMetadataCarriers(before, after, offset, options = {}) {
  // Only muxer-owned provenance/brand fields may regenerate. All custom global tags
  // remain mandatory (preserved in MP4 via -movflags +use_metadata_tags).
  const containerPromotion = Boolean(options.containerPromotion);
  const generated = ["encoder", "major_brand", "minor_version", "compatible_brands"];
  const expectedGlobal = tags(before.format?.tags, generated);
  const actualGlobal = tags(after.format?.tags, generated);
  if (containerPromotion && typeof expectedGlobal.creation_time === "string") {
    const subSecond = expectedGlobal.creation_time.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d+Z$/);
    if (subSecond && actualGlobal.creation_time === `${subSecond[1]}.000000Z`) {
      expectedGlobal.creation_time = actualGlobal.creation_time;
    }
  }
  assert.deepEqual(actualGlobal, expectedGlobal, "Global metadata changed");
  const source = before.chapters || [], candidate = after.chapters || [];
  if (!Array.isArray(source) || !Array.isArray(candidate)) throw Error("Chapter coverage changed");
  let candidateChapters = candidate;
  if (containerPromotion && source.length > 0 && candidate.length === source.length + 1) {
    const firstSourceStart = rational(source[0].start, source[0].time_base);
    const preTags = tags(candidate[0].tags);
    const preStart = rational(candidate[0].start, candidate[0].time_base);
    const preEnd = rational(candidate[0].end, candidate[0].time_base);
    if (firstSourceStart.numerator > 0n
        && Object.keys(preTags).every(key => key === "title")
        && (preTags.title ?? "") === ""
        && preStart.numerator === 0n
        && sameTimeWithin(firstSourceStart, preEnd, offset, 1n, 1000n)) {
      candidateChapters = candidate.slice(1);
    }
  }
  if (source.length !== candidateChapters.length) throw Error("Chapter coverage changed");
  source.forEach((chapter, index) => {
    const actual = candidateChapters[index];
    const beforeChapterTags = tags(chapter.tags);
    const actualChapterTags = tags(actual.tags);
    if (containerPromotion) {
      // ISO MP4 chapter tracks only carry the `title` string, not custom Matroska chapter tags.
      for (const key of Object.keys(beforeChapterTags)) {
        if (key !== "title" && actualChapterTags[key] === undefined) delete beforeChapterTags[key];
      }
      if (beforeChapterTags.title === undefined && actualChapterTags.title !== undefined) {
        beforeChapterTags.title = actualChapterTags.title;
      }
    }
    assert.deepEqual(actualChapterTags, beforeChapterTags, "Chapter metadata changed");
    for (const key of ["start", "end"]) {
      const beforeTime = rational(chapter[key], chapter.time_base);
      const afterTime = rational(actual[key], actual.time_base);
      const zeroOriginStart = containerPromotion && index === 0 && key === "start"
        && beforeTime.numerator === 0n && afterTime.numerator === 0n;
      const matches = containerPromotion
        ? (zeroOriginStart || sameTimeWithin(beforeTime, afterTime, offset, 1n, 1000n))
        : sameTime(beforeTime, afterTime, offset);
      if (!matches) throw Error("Chapter presentation boundary changed");
    }
  });
  return { status: "pass", chapters: source.length, globalTags: Object.keys(expectedGlobal) };
}

function verifyDisposition(source, candidate, containerPromotion, allowDefaultPromotion = false) {
  if (!containerPromotion && !allowDefaultPromotion) {
    assert.deepEqual(candidate.disposition, source.disposition, "Retained stream disposition changed");
    return;
  }
  const before = source.disposition || {}, after = candidate.disposition || {};
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), "Retained stream disposition changed");
  for (const key of Object.keys(before)) {
    if (after[key] === before[key]) continue;
    if (key === "default" && before[key] === 0 && after[key] === 1) continue;
    if (!containerPromotion) throw Error("Retained stream disposition changed");
    // FFmpeg isom.c dash_role_map couples hearing_impaired<->captions and visual_impaired<->descriptions.
    if (key === "captions" && before.hearing_impaired === 1 && before[key] === 0 && after[key] === 1) continue;
    if (key === "hearing_impaired" && before.captions === 1 && before[key] === 0 && after[key] === 1) continue;
    if (key === "descriptions" && before.visual_impaired === 1 && before[key] === 0 && after[key] === 1) continue;
    if (key === "visual_impaired" && before.descriptions === 1 && before[key] === 0 && after[key] === 1) continue;
    if (MP4_UNREPRESENTABLE_DISPOSITIONS.has(key) && before[key] === 1 && after[key] === 0) continue;
    throw Error("Retained stream disposition changed");
  }
}

function verifyStreamMetadata(source, candidate, transformed = false, options = {}) {
  const containerPromotion = Boolean(options.containerPromotion);
  const generated = transformed ? ["encoder"] : [];
  const pattern = containerPromotion ? MKV_MP4_GENERATED_STREAM_TAG : null;
  const before = tags(source.tags, generated, pattern), after = tags(candidate.tags, generated, pattern);
  // FFmpeg represents an unspecified language either as absent or `und`.
  // ISO MP4 `mdhd` only stores 3-letter ISO-639-2 codes (2-letter/BCP-47 normalized during promotion).
  before.language = containerPromotion ? canonicalMp4Language(before.language) : (before.language || "und");
  after.language ||= "und";
  // ISO MP4 (`movenc.c` `mov_write_track_udta_tag`) cannot carry arbitrary Matroska
  // per-stream tags (`title`, `SOURCE_ID`, `BPS-*`, `DURATION-*`, `COMMENT`, etc.).
  // Omission is allowed under containerPromotion, while mutated or fabricated tags still fail.
  if (containerPromotion) {
    for (const key of Object.keys(before)) {
      if (key !== "language" && after[key] === undefined) delete before[key];
    }
  }
  assert.deepEqual(after, before, "Retained stream metadata changed");
  verifyDisposition(source, candidate, containerPromotion, Boolean(options.allowDefaultPromotion));
}

function isSynthesizedAudioServiceSideData(source, candidate, containerPromotion) {
  return Boolean(containerPromotion && source.codec_type === "audio"
    && ["ac3", "eac3"].includes(source.codec_name)
    && !(source.side_data_list || []).length
    && Array.isArray(candidate.side_data_list) && candidate.side_data_list.length > 0
    && candidate.side_data_list.every(item => item?.side_data_type === "Audio Service Type"));
}

function isOmittedDefaultColorRange(source, candidate, containerPromotion) {
  // FFmpeg `movenc.c` omits the MP4 `colr` atom when primaries/transfer/space
  // are all unspecified, turning Matroska's default limited range (`tv`) into
  // absent (`null`, defaulting to `tv` in ISO MP4) on untouched `-c:v copy`.
  return Boolean(containerPromotion && source.codec_type === "video"
    && source.color_range === "tv" && (candidate.color_range ?? null) === null
    && (source.color_space ?? null) === null && (source.color_transfer ?? null) === null && (source.color_primaries ?? null) === null
    && (candidate.color_space ?? null) === null && (candidate.color_transfer ?? null) === null && (candidate.color_primaries ?? null) === null);
}

function isEquivalentInterlacedFieldOrder(source, candidate, containerPromotion) {
  // Matroska stores TFF/BFF as `tb`/`bt`, whereas ISO MP4 `fiel` reports `tt`/`bb`.
  return Boolean(containerPromotion && source.codec_type === "video"
    && ((source.field_order === "tb" && candidate.field_order === "tt")
      || (source.field_order === "bt" && candidate.field_order === "bb")));
}

const MDM_CHROMATICITY_KEYS = new Set([
  "red_x", "red_y", "green_x", "green_y", "blue_x", "blue_y", "white_point_x", "white_point_y",
]);
const MDM_LUMINANCE_KEYS = new Set(["min_luminance", "max_luminance"]);

function quantizeRational(value, scaleDen) {
  const match = String(value ?? "").match(/^(-?\d+)\/([1-9]\d*)$/);
  if (!match) return value;
  const num = BigInt(match[1]), den = BigInt(match[2]);
  const sign = num < 0n ? -1n : 1n;
  const absNum = num < 0n ? -num : num;
  const scaled = sign * ((absNum * scaleDen * 2n + den) / (2n * den));
  return `${scaled}/${scaleDen}`;
}

// Matroska stores Mastering Display Metadata as 32-bit IEEE-754 floats, whereas ISO MP4
// `mdcv` stores SMPTE ST 2086 unsigned fixed-point 1/50000 chromaticity and 1/10000 luminance.
function canonicalSideDataList(list, { containerPromotion = false } = {}) {
  if (!Array.isArray(list) || list.length === 0) return list ?? null;
  const normalized = list.map(entry => {
    if (!entry || typeof entry !== "object") return entry;
    const copy = { ...entry };
    if (containerPromotion && copy.side_data_type === "Mastering display metadata") {
      for (const key of Object.keys(copy)) {
        if (MDM_CHROMATICITY_KEYS.has(key)) copy[key] = quantizeRational(copy[key], 50000n);
        else if (MDM_LUMINANCE_KEYS.has(key)) copy[key] = quantizeRational(copy[key], 10000n);
      }
    }
    return Object.fromEntries(Object.entries(copy).sort(([a], [b]) => a.localeCompare(b)));
  });
  return normalized.sort((left, right) => {
    const typeCmp = String(left?.side_data_type || "").localeCompare(String(right?.side_data_type || ""));
    return typeCmp || JSON.stringify(left).localeCompare(JSON.stringify(right));
  });
}

function verifyCopiedStreamProperties(source, candidate, options = {}) {
  const containerPromotion = Boolean(options.containerPromotion);
  const promotedSubtitle = containerPromotion && source.codec_type === "subtitle"
    && ["subrip", "ass"].includes(source.codec_name) && candidate.codec_name === "mov_text";
  const synthesizedAudioSideData = isSynthesizedAudioServiceSideData(source, candidate, containerPromotion);
  const omittedDefaultRange = isOmittedDefaultColorRange(source, candidate, containerPromotion);
  const equivalentFieldOrder = isEquivalentInterlacedFieldOrder(source, candidate, containerPromotion);
  const properties = ["codec_type", ...(promotedSubtitle ? [] : ["codec_name"]), "profile", "width", "height", "pix_fmt", "sample_aspect_ratio",
    ...(equivalentFieldOrder ? [] : ["field_order"]),
    ...(omittedDefaultRange ? [] : ["color_range"]), "color_space", "color_transfer", "color_primaries", "chroma_location",
    ...(synthesizedAudioSideData ? [] : ["side_data_list"]),
    "channels", "channel_layout", "sample_rate", "sample_fmt"];
  const readProp = (stream, key) => (key === "side_data_list"
    ? canonicalSideDataList(stream.side_data_list, { containerPromotion })
    : (stream[key] ?? null));
  assert.deepEqual(properties.map(key => readProp(candidate, key)), properties.map(key => readProp(source, key)),
    "Copied stream native configuration or HDR carrier changed");
}

function verifyPreparedMediaCarriers(source, candidate, streamMaps, offset) {
  const containerPromotion = isMkvToMp4Promotion(source, candidate);
  const outputIsMovie = String(candidate?.format?.format_name || "").split(",").includes("mov");
  const allowDefaultPromotion = containerPromotion || (outputIsMovie && source.streams.length > candidate.streams.length);
  const metadata = verifyMetadataCarriers(source, candidate, offset, { containerPromotion });
  const pairs = streamMaps.map(map => {
    const before = source.streams.find(stream => stream.index === map.sourceIndex);
    const after = candidate.streams.find(stream => stream.index === map.preparedIndex);
    const promotedSubtitle = containerPromotion && before.codec_type === "subtitle"
      && ["subrip", "ass"].includes(before.codec_name) && after.codec_name === "mov_text";
    verifyStreamMetadata(before, after, promotedSubtitle, { containerPromotion, allowDefaultPromotion });
    verifyCopiedStreamProperties(before, after, { containerPromotion });
    return { map, before, after, promotedSubtitle };
  });
  return { containerPromotion, metadata, pairs };
}

module.exports = {
  canonicalMp4Language,
  canonicalSideDataList,
  isMkvToMp4Promotion,
  verifyMetadataCarriers,
  verifyPreparedMediaCarriers,
  verifyStreamMetadata,
  verifyCopiedStreamProperties,
};
