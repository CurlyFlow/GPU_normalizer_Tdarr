"use strict";

const path = require("node:path");
const { fileDigest } = require("./mediaEvidenceFiles");
const { decoderIdentity } = require("./mediaEvidenceTools");

function loadCpuReferencePlugin(plugin) {
  const cpu = require(plugin);
  // The independent plugin import-freshes library.js from its methods factory.
  const methods = path.resolve(path.dirname(plugin), "../../../../../methods");
  const roots = [require.resolve(plugin), require.resolve(path.join(methods, "lib")),
    require.resolve(path.join(methods, "library"))];
  for (const file of roots) require(file);
  return { cpu, roots };
}

function moduleEvidence(roots, owner = null) {
  if (owner && (path.resolve(owner) !== owner || roots.some(file => path.dirname(file) !== owner))) {
    throw Error("Invalid stage evidence owner");
  }
  const pending = roots.map(file => require.cache[file]);
  if (pending.some(module => !module)) throw new Error("Load the independent CPU plugin roots before attesting their module closure");
  const modules = new Map();
  while (pending.length) {
    const module = pending.pop();
    // Consumer-required worker source is directory-owned. Dynamic oracle code
    // keeps its separate complete reference closure, never this narrowed scope.
    if (owner) {
      const relative = path.relative(owner, module.filename);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    }
    if (modules.has(module.filename)) continue;
    if (modules.size >= 4096) throw new Error("CPU reference module closure exceeds its bound");
    modules.set(module.filename, fileDigest(module.filename));
    pending.push(...module.children);
  }
  return { roots, modules: [...modules].sort(([a], [b]) => a.localeCompare(b)) };
}

function referenceEnvironment(source, plugin, ffmpeg, roots = [require.resolve(plugin)]) {
  return { version: "source-normalizer-environment-v1", module_roots: roots, source_file: source, source: fileDigest(source),
    plugin_file: plugin, modules: moduleEvidence(roots).modules, decoder: decoderIdentity(ffmpeg) };
}

function assertEnvironment(expected, ffmpeg) {
  const current = referenceEnvironment(expected.source_file, expected.plugin_file, ffmpeg, expected.module_roots);
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    const changed = Object.keys(current).filter(key => JSON.stringify(current[key]) !== JSON.stringify(expected[key]));
    throw new Error(`CPU reference source, module closure or decoder changed: ${changed.join(", ")}`);
  }
}

function beginReference(provenance, preparedFile, ffmpeg) {
  assertEnvironment(provenance.reference_inputs, ffmpeg);
  return { version: "normalization-reference-proof-v1", inputs: provenance,
    prepared_input: { file: preparedFile, identity: fileDigest(preparedFile) } };
}

function finishReference(start, outputFile, ffmpeg) {
  assertEnvironment(start.inputs.reference_inputs, ffmpeg);
  if (JSON.stringify(fileDigest(start.prepared_input.file)) !== JSON.stringify(start.prepared_input.identity)) {
    throw new Error("CPU reference prepared input changed during normalization");
  }
  const output = { file: outputFile, identity: fileDigest(outputFile) };
  if (output.identity.bytes === 0) throw new Error("CPU reference output is empty");
  return { ...start, output };
}

module.exports = { loadCpuReferencePlugin, referenceEnvironment, assertEnvironment, beginReference, finishReference, moduleEvidence };
