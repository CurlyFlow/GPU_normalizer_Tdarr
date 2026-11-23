"use strict";

const { fileDigest, sameFileGeneration } = require("./mediaEvidenceFiles");
const { audioReferenceInputs } = require("./mediaAudioReference");

function finishInputs(request, chain) {
  const collected = new Map();
  function add(input) {
    if (!input?.file || !sameFileGeneration(input.identity, fileDigest(input.file))) throw Error("Finish evidence generation changed");
    if (collected.has(input.file) && !sameFileGeneration(collected.get(input.file).identity, input.identity)) throw Error("Contradictory finish generations");
    collected.set(input.file, input);
  }
  [request.preparation, request.audioIntent, ...request.videos].forEach(add);
  chain.preparation.intent.inputs.forEach(add);
  add(chain.preparation.intent.sourceInput);
  chain.preparation.intent.actual.subtitles.forEach(({ file, identity }) => add({ file, identity }));
  add(chain.preparation.intent.evidence);
  [chain.audio.intent.source, chain.audio.intent.candidate].forEach(add);
  if (chain.audio.handoff) {
    add(chain.audio.intent.handoff);
    chain.audio.handoff.evidence.forEach(add);
    add(chain.audio.handoff.transport);
    const transport = chain.audio.transport;
    transport.inputs.filter(input => input.file !== transport.output.file).forEach(add);
    if (transport.operation === "retimed") {
      [transport.carrier.snapshot, transport.plan].forEach(add);
    }
    if (chain.audio.values) {
      chain.audio.values.results.flatMap(audioReferenceInputs).forEach(add);
    }
    if (chain.audio.valueBasis) {
      add(chain.audio.values.request.basis);
      // Only the already verified current-candidate rename replaces its old path.
      chain.audio.valueBasis.inputs.filter(input => input.file !== chain.audio.handoff.temporary).forEach(add);
    }
    if (chain.audio.handoff.eofContext) add(chain.audio.handoff.eofContext);
  }
  chain.videos.forEach(receipt => {
    receipt.inputs.forEach(add);
    add(receipt.output);
    if (receipt.transport) [receipt.transport.carrier.snapshot, receipt.transport.plan].forEach(add);
    if (receipt.reference) add({ file: receipt.reference.file, identity: receipt.reference.identity });
  });
  return [...collected.values()].sort((left, right) => left.file.localeCompare(right.file));
}

module.exports = { finishInputs };
