"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { validateNativePcmPair } = require("./mediaPcmEvidence");
const { resolveVideoMap } = require("./mediaClockProtocol");
const { validateFragmentCoverage } = require("./mediaFragmentIndex");
const { validateDeclaredWindow } = require("./mediaAudioWindow");
const { encodeClockPlan } = require("./audioClockPlan");

const SCHEMA = "media-audio-transport.v1";
const SCOPE = "original-clock-transport-and-encoded-payload-preservation";

function validateIdentity(value) {
  assert.ok(value && path.isAbsolute(value.file) && path.resolve(value.file) === value.file);
  const identity = value.identity;
  assert.ok(identity && /^[a-f0-9]{64}$/.test(identity.sha256) && Number.isSafeInteger(identity.bytes) && identity.bytes > 0
    && /^\d+:\d+:\d+:-?\d+:-?\d+$/.test(identity.stamp));
}

function validateTransportReceipt(value, request) {
  assert.equal(value.schema, SCHEMA); assert.equal(value.scope, SCOPE); assert.deepEqual(value.request, request);
  assert.ok(["pass", "held"].includes(value.status) && Array.isArray(value.errors));
  assert.equal(value.status === "pass", value.errors.length === 0);
  if (value.status !== "pass") return;
  const files = [...new Set([request.sourceFile, request.candidateFile])];
  assert.equal(value.inputs.length, files.length);
  for (const file of files) {
    const input = value.inputs.find(item => item.file === file); validateIdentity(input);
  }
  validateIdentity(value.output);
  assert.ok(value.decoder?.sha256 && value.prober?.sha256 && value.producer?.modules?.length);
  assert.ok(Array.isArray(value.clock.errors) && value.clock.errors.length === 0);
  const videoMap = resolveVideoMap(request.videoMap, value.clock.source_video_streams);
  assert.deepEqual(value.clock.videoMap, videoMap);
  assert.equal(value.clock.required_video_streams, videoMap.length);
  assert.deepEqual(value.clock.videos.map(item => ({ sourceIndex: item.source_index, candidateIndex: item.index })), videoMap);
  assert.deepEqual(value.clock.audio.map(item => item.map_id), request.audioMap.map(map => map.id));
  assert.ok(value.clock.audio.every(item => item.status === "pass") && value.clock.videos.every(item => item.status === "pass"));
  assert.ok(value.clock.audio.every(item => /^\d+$/.test(item.samples) && BigInt(item.samples) > 0n
    && Number.isSafeInteger(item.segments) && item.segments > 0));
  const clockFiles = [...new Set([request.sourceFile, value.output.file])];
  assert.equal(value.clock.inputs.length, clockFiles.length);
  for (const file of clockFiles) {
    const expected = file === value.output.file ? value.output.identity : value.inputs.find(item => item.file === file).identity;
    assert.deepEqual(value.clock.inputs.find(item => item.file === file)?.identity, expected);
  }
  assert.ok(["unchanged", "retimed"].includes(value.operation));
  if (value.operation === "unchanged") {
    assert.equal(value.output.file, request.candidateFile);
    assert.deepEqual(value.output.identity, value.inputs.find(item => item.file === request.candidateFile).identity);
    assert.equal(value.carrier, null); assert.deepEqual(value.plans, []); assert.deepEqual(value.values, []);
    return;
  }
  assert.equal(path.dirname(value.output.file), path.dirname(request.candidateFile));
  assert.match(path.basename(value.output.file), /^\.audio-clock-[a-f0-9-]+\.mp4$/);
  assert.notEqual(value.output.file, request.candidateFile);
  validateIdentity(value.carrier.installed); validateIdentity(value.carrier.snapshot); validateIdentity(value.plan);
  assert.equal(value.carrier.installed.identity.sha256, value.carrier.snapshot.identity.sha256);
  assert.equal(value.plans.length, request.audioMap.length);
  const hasEof = Object.hasOwn(request, "eofContext");
  for (const item of value.plans) {
    if (!hasEof) assert.equal(Object.hasOwn(item, "normalizedEof"), false, "Unexpected normalized EOF plan without EOF context");
    else if (Object.hasOwn(item, "normalizedEof")) {
      const eof = item.normalizedEof;
      assert.ok(eof && Object.keys(eof).sort().join() === "decodedSamples,originalEnd,paddingSamples,validSamples"
        && /^[1-9]\d*$/.test(eof.validSamples) && /^[1-9]\d*$/.test(eof.decodedSamples)
        && /^\d+$/.test(eof.paddingSamples)
        && BigInt(eof.validSamples) + BigInt(eof.paddingSamples) === BigInt(eof.decodedSamples));
      validateDeclaredWindow({ input: eof.originalEnd, output: eof.originalEnd, shift: { numerator: "0", denominator: "1" } });
    }
  }
  encodeClockPlan(value.plans);
  validateFragmentCoverage(value.index, value.plans, videoMap.length);
  assert.equal(value.windows.length, request.audioMap.length);
  assert.ok(value.windows.every(item => item.status === "pass"));
  value.windows.forEach((item, index) => {
    validateDeclaredWindow(item.declared);
    validateDeclaredWindow({ input: value.plans[index].declaredEnd, output: item.declared.input,
      shift: { numerator: "0", denominator: "1" } });
  });
  assert.deepEqual(value.values.map(item => item.map_id), request.audioMap.map(map => map.id));
  for (const item of value.values) {
    assert.equal(item.status, "pass"); assert.deepEqual(item.errors, []); validateNativePcmPair(item);
  }
  assert.equal(value.payloads.length, request.audioMap.length);
  assert.ok(value.payloads.every((item, index) => item.index === index && Number.isSafeInteger(item.packets) && item.packets > 0));
  assert.equal(value.metadata.status, "pass");
}

module.exports = { SCHEMA, SCOPE, validateTransportReceipt };
