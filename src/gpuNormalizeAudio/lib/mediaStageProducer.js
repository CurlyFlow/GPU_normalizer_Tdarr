"use strict";

const path = require("node:path");
const { fileDigest } = require("./mediaEvidenceFiles");
const { moduleEvidence } = require("./mediaReferenceProof");

function unchangedModules(evidence) {
  if (!evidence || !Array.isArray(evidence.modules) || !evidence.modules.length || evidence.modules.length > 4096
      || new Set(evidence.modules.map(entry => entry[0])).size !== evidence.modules.length) throw Error("Incomplete stage source generation");
  for (const [file, identity] of evidence.modules) {
    // Tdarr Node periodically re-extracts identical LocalFlowPlugins with fresh
    // inodes/mtimes. Bind stage modules by exact cryptographic content bytes.
    const current = fileDigest(file);
    if (current.sha256 !== identity.sha256 || current.bytes !== identity.bytes) {
      throw Error("Stage source changed after verification");
    }
  }
}

function finishProducer(initial, worker) {
  unchangedModules(initial);
  return moduleEvidence([worker]);
}

function requireStageProducer(receipt, worker) {
  const root = require.resolve(worker);
  const producer = receipt.producer, current = moduleEvidence([root], path.dirname(root));
  if (!producer || !Array.isArray(producer.roots) || producer.roots.length !== 1
      || path.basename(producer.roots[0]) !== path.basename(current.roots[0])) throw Error("Foreign stage producer");
  unchangedModules(producer);
  // Audio and helper bundles install identical shared code in distinct folders.
  // Bind each required relative module to exact bytes, not those folder names.
  const owner = path.dirname(current.roots[0]), installed = path.dirname(producer.roots[0]);
  for (const [file, identity] of current.modules) {
    const relative = path.relative(owner, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw Error("Unbounded stage producer dependency");
    const actual = producer.modules.find(([name]) => name === path.join(installed, relative))?.[1];
    if (!actual || actual.sha256 !== identity.sha256 || actual.bytes !== identity.bytes) throw Error("Stage producer differs from finish verifier generation");
  }
}

module.exports = { finishProducer, requireStageProducer };
