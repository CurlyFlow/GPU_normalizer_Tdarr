"use strict";

const assert = require("node:assert/strict");
const { readRetainedReceipt, fileDigest, sameFileGeneration } = require("./mediaEvidenceFiles");
const { validateTransportReceipt } = require("./mediaAudioTransportProtocol");
const { requireStageProducer } = require("./mediaStageProducer");
const { encodeClockPlan } = require("./audioClockPlan");
const { requireCarrierEvidence } = require("./mediaCarrierEvidence");
require("./mediaAudioTransportWorker");

function requireAudioTransport(handoff, clock, tools) {
  const transport = readRetainedReceipt(handoff.transport);
  validateTransportReceipt(transport, transport.request);
  requireStageProducer(transport, "./mediaAudioTransportWorker");
  assert.equal(transport.status, "pass");
  assert.equal(transport.request.sourceFile, handoff.source.file);
  assert.equal(transport.output.file, handoff.temporary);
  assert.ok(sameFileGeneration(transport.output.identity, handoff.candidate.identity, true), "Transport output changed before handoff");
  assert.deepEqual(transport.decoder, tools.decoder); assert.deepEqual(transport.prober, tools.prober);
  assert.deepEqual(transport.request.audioMap.map(({ rate, ...map }) => map), clock.audioMap.map(({ rate, ...map }) => map));
  for (const input of transport.inputs) {
    if (input.file === transport.output.file) continue; // This exact generation was renamed by the handoff.
    assert.ok(sameFileGeneration(input.identity, fileDigest(input.file)), "Transport input changed before finish");
  }
  if (transport.operation === "retimed") {
    requireCarrierEvidence(transport.carrier, transport.plan, transport.producer, encodeClockPlan(transport.plans));
  }
  return transport;
}

module.exports = { requireAudioTransport };
