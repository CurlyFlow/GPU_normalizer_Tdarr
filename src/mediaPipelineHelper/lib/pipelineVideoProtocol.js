"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateNativePcmPair } = require("./mediaPcmEvidence");
const { validateFragmentCoverage } = require("./mediaFragmentIndex");
const { validateDeclaredWindow } = require("./mediaAudioWindow");
const { encodeClockPlan } = require("./audioClockPlan");
const assert = require("node:assert/strict");

const SCHEMA = "media-video-stage.v1";
const SCOPE = "independent-video-transform-and-stage-preservation";
function canonical(file) {
  return typeof file === "string" && !file.includes("\0") && path.isAbsolute(file)
    && path.resolve(file) === file && fs.realpathSync(file) === file;
}

function validateVideoRequest(request) {
  if (!request || Object.keys(request).sort().join() !== "candidateFile,directory,encoder,ffmpegPath,ffprobePath,settings,sidecars,sourceFile"
      || ![request.sourceFile, request.candidateFile, request.directory].every(canonical)
      || request.sourceFile === request.candidateFile
      || ![request.ffmpegPath, request.ffprobePath].every(value => typeof value === "string" && value.trim() && !value.includes("\0"))) throw Error("Invalid video stage request");
  const settings = request.settings;
  if (!settings || Object.keys(settings).sort().join() !== "videoPreset,videoQuality"
      || !/^p[1-7]$/.test(settings.videoPreset) || !Number.isInteger(settings.videoQuality)
      || settings.videoQuality < 0 || settings.videoQuality > 51) throw Error("Invalid video reference settings");
  const encoder = request.encoder;
  if (encoder !== null && (!encoder || Object.keys(encoder).sort().join() !== "encoder,outputArgs"
      || encoder.encoder !== "hevc_nvenc" || !Array.isArray(encoder.outputArgs)
      || (encoder.outputArgs.length !== 0 && (encoder.outputArgs.length !== 2 || encoder.outputArgs[0] !== "-gpu"
        || !/^(?:0|[1-9]\d{0,2})$/.test(encoder.outputArgs[1]) || Number(encoder.outputArgs[1]) > 255)))) throw Error("Invalid independent video encoder");
  if (!Array.isArray(request.sidecars) || request.sidecars.length > 64 || request.sidecars.some(sidecar => !sidecar
      || Object.keys(sidecar).sort().join() !== "file,forced,language" || !canonical(sidecar.file)
      || !/^[a-z]{2,3}$/.test(sidecar.language) || typeof sidecar.forced !== "boolean")
      || new Set(request.sidecars.map(sidecar => sidecar.file)).size !== request.sidecars.length) throw Error("Invalid video companion reference");
}

function validateVideoReceipt(value, request) {
  if (!value || value.schema !== SCHEMA || value.scope !== SCOPE
      || JSON.stringify(value.request) !== JSON.stringify(request) || !Array.isArray(value.errors)
      || !["pass", "held"].includes(value.status) || (value.status === "pass") !== (value.errors.length === 0)) throw Error("Invalid video stage receipt");
  const files = [...new Set([request.sourceFile, request.candidateFile, ...request.sidecars.map(sidecar => sidecar.file)])];
  if (!Array.isArray(value.inputs) || value.inputs.length !== files.length || files.some(file => {
    const identity = value.inputs.find(input => input.file === file)?.identity;
    return !identity || !/^[a-f0-9]{64}$/.test(identity.sha256) || !Number.isSafeInteger(identity.bytes) || identity.bytes < 1
      || !/^\d+:\d+:\d+:-?\d+:-?\d+$/.test(identity.stamp);
  })) throw Error("Incomplete video stage identities");
  if (value.status !== "pass") return;
  if (!value.output || !canonical(value.output.file) || !/^[a-f0-9]{64}$/.test(value.output.identity?.sha256)) throw Error("Missing verified video output");
  if (!Array.isArray(value.audioWindows) || !value.audioWindows.length || value.audioWindows.length !== value.audio?.length
      || value.audioWindows.some(window => window.status !== "pass")) throw Error("Incomplete video-stage audio windows");
  for (const window of value.audioWindows) {
    validateDeclaredWindow(window.declared);
    validateDeclaredWindow({ input: window.declared.input, output: window.declared.output, shift: value.commonOffset });
  }
  if (value.transport === null) {
    assert.equal(value.output.file, request.candidateFile);
    assert.deepEqual(value.output.identity, value.inputs.find(input => input.file === request.candidateFile).identity);
  } else {
    const transport = value.transport;
    if (!transport || transport.operation !== "preserved" || value.output.file === request.candidateFile
        || path.dirname(value.output.file) !== path.dirname(request.candidateFile)
        || !/^\.audio-preserved-[a-f0-9-]+\.mp4$/.test(path.basename(value.output.file))
        || transport.metadata?.status !== "pass" || !transport.carrier?.installed || !transport.carrier?.snapshot
        || !transport.plan || !Array.isArray(transport.plans) || transport.plans.length !== value.audio?.length
        || !Array.isArray(transport.windows) || transport.windows.length !== value.audio.length || transport.windows.some(item => item.status !== "pass")
        || !Array.isArray(transport.payloads) || transport.payloads.length !== value.referencePackets?.length
        || transport.payloads.some(item => item.status !== "pass")) throw Error("Incomplete audio-preserving video transport");
    assert.deepEqual(transport.output, value.output);
    assert.deepEqual(value.audioWindows, transport.windows);
    assert.equal(transport.carrier.installed.identity.sha256, transport.carrier.snapshot.identity.sha256);
    assert.equal(transport.carrier.installed.identity.bytes, transport.carrier.snapshot.identity.bytes);
    encodeClockPlan(transport.plans);
    validateFragmentCoverage(transport.index, transport.plans, value.videos.length);
    transport.windows.forEach((item, index) => {
      validateDeclaredWindow(item.declared);
      validateDeclaredWindow({ input: transport.plans[index].declaredEnd, output: item.declared.input,
        shift: { numerator: "0", denominator: "1" } });
    });
  }
  if ((value.reference !== null && !/^[a-f0-9]{64}$/.test(value.reference?.identity?.sha256))
      || value.metadata?.status !== "pass"
      || !Array.isArray(value.videos) || !value.videos.length || value.videos.some((video, index) => video.index !== index || video.status !== "pass")
      || !Array.isArray(value.audio) || !value.audio.length || value.audio.some(audio => audio.status !== "pass")
      || !Array.isArray(value.copiedAudio) || value.copiedAudio.length !== value.audio.length
      || value.copiedAudio.some(audio => audio.status !== "pass" || audio.source.sha256 !== audio.candidate.sha256 || audio.source.bytes !== audio.candidate.bytes)
      || !Array.isArray(value.referencePackets) || !value.referencePackets.length
      || value.referencePackets.some((item, index) => item.index !== index || item.status !== "pass")) throw Error("Incomplete video transform proof");
  value.copiedAudio.forEach((audio, index) => {
    if (audio.map_id !== value.audio[index].map_id || !Array.isArray(audio.errors) || audio.errors.length) throw Error("Invalid video-stage audio verdict");
    validateNativePcmPair(audio);
  });
}

module.exports = { SCHEMA, SCOPE, validateVideoRequest, validateVideoReceipt };
