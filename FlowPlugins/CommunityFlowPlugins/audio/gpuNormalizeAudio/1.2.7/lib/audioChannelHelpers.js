"use strict";

const { intNum, langTag } = require("./common");

function primaryAudioChannels(stream, fallback) {
  const parsed = Number.parseInt(String((stream || {}).channels), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sourceChannelLayout(stream, channels) {
  const raw = String((stream || {}).channel_layout || "").trim();
  if (!raw || raw === "unknown") return "";
  if (!/^[A-Za-z0-9_.()+-]+$/.test(raw)) return "";
  if (channels === 2 && raw !== "stereo") return "";
  const codec = String((stream || {}).codec_name || (stream || {}).codec || "").toLowerCase();
  if (channels === 6 && raw === "5.1" && codec === "ac3") return "5.1(side)";
  return raw;
}

function isTrueHdStream(stream) {
  return String((stream || {}).codec_name || (stream || {}).codec || "").toLowerCase() === "truehd";
}

function isMp4Container(container) {
  return new Set(["mp4", "m4v"]).has(String(container || "").trim().toLowerCase());
}

function shouldEncodeCopiedAudioForMp4(container, stream) {
  if (!isMp4Container(container)) return false;
  const codec = String((stream || {}).codec_name || (stream || {}).codec || "").toLowerCase();
  return !new Set(["aac", "alac", "mp3", "mp4a"]).has(codec);
}

function mp4TrueHdOutputArgs(container, copiedStreams) {
  if (!isMp4Container(container)) return [];
  return (copiedStreams || []).some(isTrueHdStream) ? ["-strict", "-2"] : [];
}

function channelCount(value, primaryAudioStream, fallback) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (raw === "" || raw === "auto" || raw === "source") return primaryAudioChannels(primaryAudioStream, fallback);
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : primaryAudioChannels(primaryAudioStream, fallback);
}

function streamSummary(stream, idx) {
  const tags = (stream || {}).tags || {};
  const language = langTag(tags.language || (stream || {}).language || "und");
  const codec = String((stream || {}).codec_name || (stream || {}).codec || "unknown");
  const channels = primaryAudioChannels(stream, 0);
  const layout = String((stream || {}).channel_layout || "").trim();
  const sampleRate = intNum((stream || {}).sample_rate, 0);
  const title = String(tags.title || "").trim().replace(/\s+/g, " ").slice(0, 80);
  return `#${idx} ${language} ${codec}${channels > 0 ? ` ${channels}ch` : ""}${layout && layout !== "unknown" ? ` ${layout}` : ""}${sampleRate > 0 ? ` ${sampleRate}Hz` : ""}${title ? ` title="${title}"` : ""}`;
}

module.exports = {
  channelCount,
  isMp4Container,
  mp4TrueHdOutputArgs,
  primaryAudioChannels,
  shouldEncodeCopiedAudioForMp4,
  sourceChannelLayout,
  streamSummary,
};
