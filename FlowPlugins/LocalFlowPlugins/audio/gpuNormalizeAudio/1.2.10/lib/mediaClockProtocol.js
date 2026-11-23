"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateNativePcmPair } = require("./mediaPcmEvidence");

const SCHEMA = "media-clock-verification.v3";
const SCOPE = "clocks-copied-video-and-declared-copy-audio";
const MAX_BYTES = 4 * 1024 * 1024;

function validateEofBinding(binding, directory) {
  if (!binding || Object.keys(binding).sort().join() !== "file,identity"
      || typeof binding.file !== "string" || binding.file.includes("\0") || !path.isAbsolute(binding.file)
      || path.resolve(binding.file) !== binding.file || fs.realpathSync(binding.file) !== binding.file
      || Object.keys(binding.identity || {}).sort().join() !== "bytes,sha256,stamp"
      || !/^[a-f0-9]{64}$/.test(binding.identity.sha256)
      || !Number.isSafeInteger(binding.identity.bytes) || binding.identity.bytes < 1
      || typeof binding.identity.stamp !== "string"
      || path.basename(binding.file) !== "receipt.json"
      || path.dirname(path.dirname(binding.file)) !== directory
      || !/^\.media-eof-context-[A-Za-z0-9]+$/.test(path.basename(path.dirname(binding.file)))) {
    throw Error("Invalid normalized EOF context receipt binding");
  }
}

function resolveVideoMap(value, sourceCount) {
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 0 || sourceCount > 256) throw Error("Invalid source video count");
  const maps = value === null ? Array.from({ length: sourceCount }, (_, index) => ({ sourceIndex: index, candidateIndex: index })) : value;
  if (!Array.isArray(maps) || maps.length > 256) throw Error("Invalid copied video mapping");
  maps.forEach((map, index) => {
    if (!map || Object.keys(map).sort().join() !== "candidateIndex,sourceIndex" || map.candidateIndex !== index
        || !Number.isSafeInteger(map.sourceIndex) || map.sourceIndex < 0 || map.sourceIndex >= sourceCount
        || (index > 0 && map.sourceIndex <= maps[index - 1].sourceIndex)) throw Error("Invalid copied video mapping");
  });
  return maps;
}

function validateSourceClockTick(tick) {
  if (!tick || Object.keys(tick).sort().join() !== "denominator,numerator"
      || typeof tick.numerator !== "string" || !/^[1-9]\d{0,9}$/.test(tick.numerator)
      || typeof tick.denominator !== "string" || !/^[1-9]\d{0,9}$/.test(tick.denominator)
      || BigInt(tick.numerator) >= BigInt(tick.denominator)
      || BigInt(tick.denominator) > 1000000n) {
    throw Error("Invalid source container clock tick");
  }
}

function validateRequest(request) {
  const hasEof = request && Object.hasOwn(request, "eofContext");
  const hasTick = request && Object.hasOwn(request, "sourceClockTick");
  const expectedKeys = `audioMap,candidateFile,directory,${hasEof ? "eofContext," : ""}ffmpegPath,ffprobePath,${hasTick ? "sourceClockTick," : ""}sourceFile,videoMap`;
  if (!request || Object.keys(request).sort().join() !== expectedKeys) {
    throw Error("Invalid clock verification request");
  }
  for (const key of ["sourceFile", "candidateFile", "directory"]) {
    if (typeof request[key] !== "string" || request[key].includes("\0") || !path.isAbsolute(request[key])
        || path.resolve(request[key]) !== request[key] || fs.realpathSync(request[key]) !== request[key]) {
      throw Error("Clock verification requires canonical paths");
    }
  }
  if (hasEof) validateEofBinding(request.eofContext, request.directory);
  if (hasTick) validateSourceClockTick(request.sourceClockTick);
  for (const key of ["ffmpegPath", "ffprobePath"]) {
    if (typeof request[key] !== "string" || !request[key].trim() || request[key].includes("\0")) throw Error("Invalid media executable");
  }
  resolveVideoMap(request.videoMap, 256);
  if (!Array.isArray(request.audioMap) || request.audioMap.length > 128
      || new Set(request.audioMap.map(map => map.id)).size !== request.audioMap.length) throw Error("Invalid audio clock map");
  request.audioMap.forEach((map, index) => {
    if (!map || Object.keys(map).sort().join() !== "candidateIndex,channels,compareSamples,id,rate,sampleBytes,sourceIndex"
        || typeof map.id !== "string" || !map.id || map.id.length > 128 || map.candidateIndex !== index
        || !Number.isSafeInteger(map.sourceIndex) || map.sourceIndex < 0
        || !Number.isSafeInteger(map.channels) || map.channels < 1 || map.channels > 64
        || (map.rate !== null && (!Number.isSafeInteger(map.rate) || map.rate < 1 || map.rate > 1000000))
        || typeof map.compareSamples !== "boolean" || ![4, 8].includes(map.sampleBytes)) throw Error("Invalid audio clock mapping");
  });
}

function validateReceipt(value, request) {
  if (value.schema !== SCHEMA || value.scope !== SCOPE || !Array.isArray(value.errors) || !Array.isArray(value.clockErrors)
      || !["pass", "held"].includes(value.status) || (value.status === "pass") !== (value.errors.length === 0)
      || value.sourceFile !== request.sourceFile || value.candidateFile !== request.candidateFile
      || !Array.isArray(value.audioMap) || value.audioMap.length !== request.audioMap.length) throw Error("Invalid receipt");
  const videoMap = resolveVideoMap(request.videoMap, value.source_video_streams);
  if (JSON.stringify(value.videoMap) !== JSON.stringify(videoMap) || value.required_video_streams !== videoMap.length
      || !Array.isArray(value.videos) || value.videos.length !== videoMap.length) throw Error("Incomplete copied video proof");
  value.videos.forEach((video, index) => {
    if (video.index !== index || video.source_index !== videoMap[index].sourceIndex || !["pass", "fail"].includes(video.status)
        || (video.status !== "pass" && value.status === "pass")) throw Error("Invalid copied video proof");
  });
  if (!Array.isArray(value.audio) || value.audio.length !== request.audioMap.length) throw Error("Incomplete audio clock proof");
  request.audioMap.forEach((map, index) => {
    const resolved = value.audioMap[index], clock = value.audio[index];
    if (Object.keys(resolved).sort().join() !== Object.keys(map).sort().join()
        || Object.entries(map).some(([key, expected]) => key !== "rate" && resolved[key] !== expected)
        || !Number.isSafeInteger(resolved.rate) || resolved.rate < 1 || resolved.rate > 1000000
        || (map.rate !== null && resolved.rate !== map.rate)) throw Error("Invalid resolved mapping");
    if (clock.map_id !== map.id || !["pass", "fail"].includes(clock.status)
        || (clock.status !== "pass" && value.status === "pass")) throw Error("Invalid audio clock proof");
  });
  const files = [...new Set([request.sourceFile, request.candidateFile])];
  if (!Array.isArray(value.inputs) || value.inputs.length !== files.length || files.some(file => {
    const identity = value.inputs.find(input => input.file === file)?.identity;
    return !identity || !/^[a-f0-9]{64}$/.test(identity.sha256) || !Number.isSafeInteger(identity.bytes) || identity.bytes < 1
      || typeof identity.stamp !== "string" || !/^\d+:\d+:\d+:-?\d+:-?\d+$/.test(identity.stamp);
  })) throw Error("Incomplete media byte proof");
  const expectedIds = request.audioMap.filter(map => map.compareSamples).map(map => map.id);
  if (!Array.isArray(value.copiedAudio) || JSON.stringify(value.copiedAudio.map(item => item.map_id)) !== JSON.stringify(expectedIds)) {
    throw Error("Incomplete copied audio proof");
  }
  for (const item of value.copiedAudio) {
    if (!["pass", "held"].includes(item.status) || !Array.isArray(item.errors)
        || (item.status === "pass") !== (item.errors.length === 0)
        || (item.status !== "pass" && value.status === "pass")) throw Error("Invalid copied audio verdict");
    if (item.status !== "pass") continue;
    if (item.packetCopyFallback === true) {
      if (!Number.isSafeInteger(item.packets) || item.packets < 1) throw Error("Invalid copied audio packet fallback");
      continue;
    }
    validateNativePcmPair(item);
  }
  if (Object.hasOwn(request, "eofContext")) {
    validateEofBinding(request.eofContext, path.dirname(path.dirname(request.eofContext.file)));
    if (JSON.stringify(value.eofContext) !== JSON.stringify(request.eofContext)) {
      throw Error("Clock receipt EOF context differs from request");
    }
  } else if (Object.hasOwn(value, "eofContext") && value.eofContext !== null) {
    throw Error("Unexpected EOF context in strict clock receipt");
  }
  if (Object.hasOwn(request, "sourceClockTick")) {
    validateSourceClockTick(request.sourceClockTick);
    if (JSON.stringify(value.sourceClockTick) !== JSON.stringify(request.sourceClockTick)) {
      throw Error("Clock receipt source tick differs from request");
    }
  } else if (Object.hasOwn(value, "sourceClockTick") && value.sourceClockTick !== null) {
    throw Error("Unexpected source clock tick in strict clock receipt");
  }
}

module.exports = { SCHEMA, SCOPE, MAX_BYTES, resolveVideoMap, validateEofBinding, validateSourceClockTick, validateRequest, validateReceipt };
