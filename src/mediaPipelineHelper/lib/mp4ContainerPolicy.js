"use strict";

const { canonicalMp4Language } = require("./mediaMetadataEvidence");

// Direct-Play target video codecs for Plex MP4 publication: HEVC (`hvc1`) and
// AV1 (`av01`, including 10-bit HDR10 / Dolby Vision Profile 10) stay copied;
// legacy codecs (H.264, MPEG-4, VP9, MPEG-2) convert to HEVC (`hvc1`).
const PLEX_DIRECT_VIDEO_CODECS = new Set(["hevc", "av1"]);

// H.265 Annex E `chroma_sample_loc_type` values for 4:2:0 VUI preservation when
// `hevc_nvenc` omits `chroma_loc_info_present_flag`.
const HEVC_CHROMA_SAMPLE_LOC = Object.freeze({
  left: 0,
  center: 1,
  topleft: 2,
  top: 3,
  bottomleft: 4,
  bottom: 5,
});

const YUV420_PIX_FMTS = new Set(["yuv420p", "yuvj420p", "yuv420p10le", "yuv420p12le", "nv12", "p010le"]);

function isPlexDirectVideoCodec(codecName) {
  return PLEX_DIRECT_VIDEO_CODECS.has(String(codecName || "").toLowerCase());
}

function sourceVideoTimescale(streams) {
  for (const stream of streams || []) {
    if ((stream.codec_type || stream.type) !== "video") continue;
    const match = String(stream.time_base || "").match(/^1\/([1-9]\d{0,9})$/);
    if (match && Number(match[1]) > 0 && Number(match[1]) <= 1000000) return match[1];
  }
  return null;
}

function pushPlexMp4VideoTagArgs(outputs, videoOrdinal, targetCodecName) {
  // Apple TV / tvOS / iOS / macOS / Safari Plex Direct Play requires `hvc1`
  // rather than FFmpeg's default `hev1` sample-entry tag on MP4 HEVC tracks.
  if (String(targetCodecName || "").toLowerCase() === "hevc") {
    outputs.push(`-tag:v:${videoOrdinal}`, "hvc1");
  }
}

function pushHevcChromaLocationBsfArgs(outputs, stream, videoOrdinal) {
  const loc = HEVC_CHROMA_SAMPLE_LOC[stream?.chroma_location];
  if (loc === undefined || loc === 0) return;
  if (stream?.pix_fmt && !YUV420_PIX_FMTS.has(stream.pix_fmt)) return;
  outputs.push(`-bsf:v:${videoOrdinal}`, `hevc_metadata=chroma_sample_loc_type=${loc}`);
}

function pushCanonicalMp4StreamLanguageArgs(outputs, streams) {
  (streams || []).forEach((stream, outputIndex) => {
    const rawLang = stream?.tags?.language;
    if (typeof rawLang !== "string" || !rawLang.trim()) return;
    const normalized = canonicalMp4Language(rawLang);
    if (normalized !== rawLang.trim().toLowerCase()) {
      outputs.push(`-metadata:s:${outputIndex}`, `language=${normalized}`);
    }
  });
}

function pushPlexFinalMp4Flags(outputs) {
  // Place `moov` before `mdat` (`+faststart`) for instant Plex Direct Play start
  // over network/VFS mounts while preserving custom metadata tags and DV/HDR atoms.
  outputs.push("-movflags", "+faststart", "-movflags", "+use_metadata_tags", "-strict", "-2");
}

module.exports = {
  HEVC_CHROMA_SAMPLE_LOC,
  PLEX_DIRECT_VIDEO_CODECS,
  isPlexDirectVideoCodec,
  pushCanonicalMp4StreamLanguageArgs,
  pushHevcChromaLocationBsfArgs,
  pushPlexFinalMp4Flags,
  pushPlexMp4VideoTagArgs,
  sourceVideoTimescale,
};
