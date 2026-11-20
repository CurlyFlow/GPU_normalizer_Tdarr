"use strict";

const {
  shouldEncodeCopiedAudioForMp4,
} = require("./audioChannelHelpers");
const {
  intNum,
  langTag,
} = require("./common");
const {
  renderShellCommand,
} = require("./commandRenderer");

const STREAM_TYPE_ORDER = ["video", "audio", "subtitle", "attachment", "data"];

function codecName(stream) {
  const value = String((stream || {}).codec_name || (stream || {}).codec || "").trim().toLowerCase();
  return value || null;
}

function audioLanguage(stream, explicitLanguage = null) {
  const tags = (stream || {}).tags || {};
  const value = String(explicitLanguage || tags.language || (stream || {}).language || "und").trim();
  return langTag(value || "und").toLowerCase();
}

function expectedCopiedStream(stream) {
  const type = String((stream || {}).codec_type || "").trim().toLowerCase();
  return {
    codecName: type === "data" ? null : codecName(stream),
    type,
  };
}

function expectedAudioStream(spec, container) {
  if (spec.kind === "source") {
    const stream = spec.stream || {};
    return {
      channels: Math.max(0, intNum(stream.channels, 0)) || null,
      codecName: shouldEncodeCopiedAudioForMp4(container, stream) ? "aac" : codecName(stream),
      language: audioLanguage(stream, spec.language),
      type: "audio",
    };
  }
  if (!spec.plan) throw new Error(`GPU normalize output contract missing plan for ${spec.kind}`);
  return {
    channels: Math.max(0, intNum(spec.plan.channels, 0)) || null,
    codecName: "aac",
    language: audioLanguage(null, spec.language),
    type: "audio",
  };
}

function createOutputStreamContract({ inputStreams, audioSpecs, container }) {
  const streams = Array.isArray(inputStreams) ? inputStreams : [];
  const expected = [];
  for (const type of STREAM_TYPE_ORDER) {
    if (type === "audio") {
      expected.push(...audioSpecs.map((spec) => expectedAudioStream(spec, container)));
      continue;
    }
    expected.push(...streams
      .filter((stream) => String((stream || {}).codec_type || "").toLowerCase() === type)
      .map(expectedCopiedStream));
  }
  return expected;
}

function buildOutputProbeCommand({ ffmpegPath, outputPath }) {
  return renderShellCommand([
    ffmpegPath,
    "-hide_banner", "-loglevel", "info", "-nostats", "-nostdin",
    "-i", outputPath,
    "-map", "0:a:0", "-c", "copy", "-t", "0", "-f", "null", "/dev/null",
  ]);
}

function audioChannelsFromProbeLine(line) {
  if (/\bmono\b/i.test(line)) return 1;
  if (/\bstereo\b/i.test(line)) return 2;
  const surround = String(line).match(/\b(\d+)\.(\d+)\b/);
  if (surround) return Number(surround[1]) + Number(surround[2]);
  const channels = String(line).match(/\b(\d+)\s+channels?\b/i);
  return channels ? Number(channels[1]) : null;
}

function parseOutputProbe(output) {
  const streams = [];
  let readingInput = false;
  for (const rawLine of String(output || "").replace(/\r/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (/^Input #0,/.test(line)) {
      readingInput = true;
      continue;
    }
    if (readingInput && /^Output #0,/.test(line)) break;
    if (!readingInput) continue;
    const match = line.match(/^Stream #0:(\d+)(?:\[[^\]]+\])?(?:\(([^)]+)\))?.*?:\s+(Video|Audio|Subtitle|Attachment|Data):\s*([^\s,(]+)/i);
    if (!match) continue;
    const type = match[3].toLowerCase();
    streams.push({
      index: Number(match[1]),
      codec_type: type,
      codec_name: match[4].toLowerCase(),
      channels: type === "audio" ? audioChannelsFromProbeLine(line) : null,
      tags: match[2] ? { language: match[2] } : {},
    });
  }
  if (streams.length === 0) throw new Error("GPU normalize output validation found no FFmpeg input streams");
  return streams.sort((left, right) => left.index - right.index);
}

function describeExpectedStream(stream) {
  return [
    stream.type,
    stream.codecName,
    stream.channels ? `${stream.channels}ch` : null,
    stream.language ? `language=${stream.language}` : null,
  ].filter(Boolean).join("/");
}

function describeActualStream(stream) {
  const type = String((stream || {}).codec_type || "unknown").trim().toLowerCase();
  return describeExpectedStream({
    channels: Math.max(0, intNum((stream || {}).channels, 0)) || null,
    codecName: codecName(stream),
    language: type === "audio" ? audioLanguage(stream) : null,
    type,
  });
}

function validateOutputStreams(expectedStreams, actualStreams) {
  if (actualStreams.length !== expectedStreams.length) {
    const expected = expectedStreams.map(describeExpectedStream).join(", ");
    const actual = actualStreams.map((stream) => `${stream.index}:${describeActualStream(stream)}`).join(", ");
    throw new Error(`GPU normalize output validation failed: expected ${expectedStreams.length} streams, found ${actualStreams.length}; expected [${expected}]; actual [${actual}]`);
  }
  for (let idx = 0; idx < expectedStreams.length; idx += 1) {
    const expected = expectedStreams[idx];
    const actual = actualStreams[idx] || {};
    const actualType = String(actual.codec_type || "").trim().toLowerCase();
    const actualCodec = codecName(actual);
    const actualChannels = Math.max(0, intNum(actual.channels, 0)) || null;
    const actualLanguage = actualType === "audio" ? audioLanguage(actual) : null;
    const mismatched = actualType !== expected.type
      || (expected.codecName && actualCodec !== expected.codecName)
      || (expected.channels && actualChannels !== expected.channels)
      || (expected.language && actualLanguage !== expected.language);
    if (mismatched) {
      throw new Error(`GPU normalize output validation failed at stream ${idx}: expected ${describeExpectedStream(expected)}, found ${describeActualStream(actual)}`);
    }
  }
}

module.exports = {
  buildOutputProbeCommand,
  createOutputStreamContract,
  parseOutputProbe,
  validateOutputStreams,
};
