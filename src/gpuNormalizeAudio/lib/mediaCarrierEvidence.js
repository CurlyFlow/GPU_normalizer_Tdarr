"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fileDigest, sameFileGeneration } = require("./mediaEvidenceFiles");

function requireCarrierEvidence(carrier, plan, producer, expectedPlan) {
  const installed = path.resolve(path.dirname(producer.roots[0]), "../runtime/bin/audio_clock_mux");
  assert.equal(carrier.installed.file, installed);
  for (const artifact of [carrier.installed, carrier.snapshot, plan]) {
    assert.ok(sameFileGeneration(artifact.identity, fileDigest(artifact.file)), "Transport artifact changed before finish");
  }
  const current = fileDigest(path.resolve(__dirname, "../runtime/bin/audio_clock_mux"));
  assert.equal(carrier.installed.identity.sha256, current.sha256);
  assert.equal(carrier.installed.identity.bytes, current.bytes);
  assert.equal(carrier.installed.identity.sha256, carrier.snapshot.identity.sha256);
  assert.equal(carrier.installed.identity.bytes, carrier.snapshot.identity.bytes);
  assert.equal(fs.readFileSync(plan.file, "utf8"), expectedPlan);
}

module.exports = { requireCarrierEvidence };
