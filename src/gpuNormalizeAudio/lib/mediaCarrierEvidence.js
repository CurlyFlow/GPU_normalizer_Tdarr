"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fileDigest, sameFileGeneration } = require("./mediaEvidenceFiles");

function requireCarrierEvidence(carrier, plan, producer, expectedPlan) {
  const ownerRoot = path.dirname(producer.roots[0]);
  const installed = path.resolve(ownerRoot, "../runtime/bin/audio_clock_mux");
  const shared = path.resolve(__dirname, "../runtime/bin/audio_clock_mux");
  const expected = fs.existsSync(installed) ? installed
    : ownerRoot !== __dirname && fs.existsSync(shared) ? shared : installed;
  assert.equal(carrier.installed.file, expected);
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
