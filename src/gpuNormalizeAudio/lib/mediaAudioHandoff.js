"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { fileDigest, sameFileGeneration, readRetainedReceipt, retainedReceipt, writePrivateReceipt } = require("./mediaEvidenceFiles");
const { validateReceipt } = require("./mediaClockProtocol");
const { CPU_PLUGIN_SHA256, validateValueReceipt } = require("./mediaAudioValueProtocol");
const { createAudioSelectionIntent } = require("./audioValueSelection");
const { inspectStreams } = require("./mediaSourceProbe");
const { decoderIdentity } = require("./mediaEvidenceTools");
const { requireStageProducer } = require("./mediaStageProducer");
const { requireAudioTransport } = require("./mediaAudioTransportAdmission");
const { requireAudioValueBasis } = require("./mediaAudioValueBasis");
const { audioReferenceInputs } = require("./mediaAudioReference");
const { validateNormalizedEofContext } = require("./mediaAudioEofContext");
const { sourceClockTickForPreparation } = require("./pipelinePreparationMap");

function bindAudioHandoff(args, temporary, output) {
  try {
    const clock = args.variables.gpuNormalizeAudioClock, values = args.variables.gpuNormalizeAudioValues;
    validateReceipt(clock, { sourceFile: args.inputFileObj._id, candidateFile: temporary,
      audioMap: clock.audioMap, videoMap: clock.videoMap,
      ...(clock.eofContext ? { eofContext: clock.eofContext } : {}),
      ...(clock.sourceClockTick ? { sourceClockTick: clock.sourceClockTick } : {}) });
    validateValueReceipt(values, values.request);
    if (clock.status !== "pass" || values.status !== "pass" || values.request.sourceFile !== clock.sourceFile
        || values.request.candidateFile !== temporary || values.inputs.length !== clock.inputs.length
        || values.inputs.some(input => !clock.inputs.some(other => other.file === input.file
          && sameFileGeneration(input.identity, other.identity)))
        || JSON.stringify(values.decoder) !== JSON.stringify(clock.decoder)
        || JSON.stringify(values.prober) !== JSON.stringify(clock.prober)) throw Error("Audio proofs bind different generations");
    if (temporary === output || path.dirname(temporary) !== path.dirname(output) || fs.existsSync(temporary)
        || fs.realpathSync(output) !== output) throw Error("Audio handoff is not the expected completed rename");
    const source = { file: args.inputFileObj._id, identity: fileDigest(args.inputFileObj._id) };
    const candidate = { file: output, identity: fileDigest(output) };
    if (!sameFileGeneration(values.inputs.find(input => input.file === source.file)?.identity, source.identity)
        || !sameFileGeneration(values.inputs.find(input => input.file === temporary)?.identity, candidate.identity, true)) {
      throw Error("Audio handoff changed its verified file generation");
    }
    requireStageProducer(clock, "./mediaClockWorker");
    requireStageProducer(values, "./mediaAudioValueWorker");
    assert.deepEqual(decoderIdentity(values.prober.executable), values.prober, "Selection prober generation changed");
    const streams = inspectStreams(source.file, (values.prober.native || values.prober).executable);
    const selection = createAudioSelectionIntent(args, values.request.maps, streams);
    assert.deepEqual(selection.maps, values.request.maps, "Audio values differ from configured selection");
    assert.equal(clock.audioMap.length, selection.maps.length, "Audio clocks differ from configured selection");
    selection.maps.forEach((map, index) => {
      const timed = clock.audioMap[index];
      for (const key of ["sourceIndex", "candidateIndex", "channels"]) {
        assert.equal(timed[key], map[key], "Audio clocks differ from configured selection");
      }
    });
    assert.deepEqual(fileDigest(source.file), source.identity, "Selection source generation changed");
    assert.deepEqual(fileDigest(candidate.file), candidate.identity, "Selection output generation changed");
    assert.deepEqual(decoderIdentity(values.prober.executable), values.prober, "Selection prober generation changed");
    const evidence = [retainedReceipt(clock), retainedReceipt(values)];
    for (const input of values.results.flatMap(audioReferenceInputs)) {
      if (!sameFileGeneration(input.identity, fileDigest(input.file))) {
        throw Error("Audio comparison reference changed before handoff");
      }
    }
    const expectedTick = sourceClockTickForPreparation(args, (values.prober.native || values.prober).executable);
    assert.deepEqual(clock.sourceClockTick ?? null, expectedTick, "Audio clock source tick differs from preparation");
    const transport = args.variables.gpuNormalizeAudioTransport;
    const transportBinding = transport ? retainedReceipt(transport) : null;
    if (Object.hasOwn(values.request, "basis") || clock.eofContext) {
      assert.ok(Object.hasOwn(values.request, "basis"), "Normalized EOF handoff requires the first-candidate value basis");
      const verified = requireAudioTransport({ source, candidate, temporary, transport: transportBinding }, clock,
        { decoder: values.decoder, prober: values.prober });
      assert.deepEqual(verified.output.identity, values.inputs.find(input => input.file === temporary).identity);
      requireAudioValueBasis(values, verified.inputs.find(input => input.file === verified.request.candidateFile),
        { from: temporary, to: output });
      if (clock.eofContext) {
        const eof = validateNormalizedEofContext(readRetainedReceipt(clock.eofContext), {
          args, candidateFile: verified.request.candidateFile,
          expectedPluginSha256: values.request.plugin?.sha256 || CPU_PLUGIN_SHA256,
          renamed: { from: temporary, to: output },
        });
        assert.deepEqual(eof.valueBasis, values.request.basis, "Normalized EOF basis differs from final values");
      }
    }
    const receipt = writePrivateReceipt(path.dirname(output), "media-handoff", {
      schema: "media-audio-handoff.v2", scope: "configured-selection-and-verified-audio-rename", status: "pass",
      source, candidate, temporary, selection, evidence, transport: transportBinding,
      ...(clock.eofContext ? { eofContext: clock.eofContext } : {}) });
    args.variables.gpuNormalizeAudioHandoff = receipt;
    return receipt;
  } catch (error) {
    error.code = "MEDIA_AUDIO_HANDOFF_HELD";
    error.preserveMediaEvidence = true;
    throw error;
  }
}

module.exports = { bindAudioHandoff };
