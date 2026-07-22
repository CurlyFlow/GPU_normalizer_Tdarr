"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const sourceRoot = process.env.QUALITY_SKIP_LOCAL_SOURCE === "1"
  ? path.join(repoRoot, ".quality-source-not-present")
  : path.join(repoRoot, "src/gpuNormalizeAudio");

function filesBelow(root, extension) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function ownersOf(root, extension, pattern) {
  return filesBelow(root, extension)
    .filter((file) => pattern.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file));
}

test("every checked JavaScript tree is acyclic", () => {
  const releaseBase = path.join(repoRoot, "FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio");
  const release = fs.readdirSync(releaseBase).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  for (const root of [path.join(releaseBase, release), sourceRoot].filter(fs.existsSync)) {
    const files = filesBelow(root, ".js");
    const graph = new Map(files.map((file) => [file, []]));
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
        const base = path.resolve(path.dirname(file), match[1]);
        const dependency = fs.existsSync(`${base}.js`) ? `${base}.js` : path.join(base, "index.js");
        if (graph.has(dependency)) graph.get(file).push(dependency);
      }
    }
    const visiting = new Set();
    const visited = new Set();
    function visit(file) {
      assert(!visiting.has(file), `JavaScript dependency cycle through ${path.relative(root, file)}`);
      if (visited.has(file)) return;
      visiting.add(file);
      graph.get(file).forEach(visit);
      visiting.delete(file);
      visited.add(file);
    }
    files.forEach(visit);
  }
});

test("local runtime policies and exact helpers have one owner", { skip: !fs.existsSync(sourceRoot) }, () => {
  const jsRoot = path.join(sourceRoot, "lib");
  const pyRoot = path.join(sourceRoot, "runtime/bin");
  const cudaRoot = path.join(sourceRoot, "runtime");
  assert.deepEqual(ownersOf(jsRoot, ".js", /LOUDNORM_GPU_ORIGINAL_STATS_AFTER_CPU/), ["splitStatsPolicy.js"]);
  assert.deepEqual(ownersOf(jsRoot, ".js", /LOUDNORM_GPU_FIRST_PASS_ORIGINAL_ONLY/), ["pluginConfig.js"]);
  assert.deepEqual(ownersOf(jsRoot, ".js", /^function intNum\(/m), ["common.js"]);
  assert.deepEqual(ownersOf(jsRoot, ".js", /^function niceCommand\(/m), ["common.js"]);
  assert.deepEqual(ownersOf(pyRoot, ".py", /^def copy_device_array\(/m), ["cuda_driver.py"]);
  assert.deepEqual(ownersOf(cudaRoot, ".py", /^def read_cuda_source_with_local_includes\(/m), ["bin/cuda_abi_validation.py"]);
});

test("local paired apply, feedback, and config boundaries stay structured", { skip: !fs.existsSync(sourceRoot) }, () => {
  const paired = fs.readFileSync(path.join(sourceRoot, "lib/pairedApplyConfig.js"), "utf8");
  const feedback = fs.readFileSync(path.join(sourceRoot, "runtime/bin/feedback_modes.py"), "utf8");
  const runtimeConfig = fs.readFileSync(path.join(sourceRoot, "runtime/bin/runtime_config.py"), "utf8");
  assert.doesNotMatch(paired, /pairStereoFallbackApply[A-Z]/);
  assert.match(feedback, /class FeedbackLaunchPlan:/);
  assert.match(feedback, /class FeedbackApplyMode\(Enum\):/);
  assert.doesNotMatch(runtimeConfig, /setattr\(self,/);
  assert.match(runtimeConfig, /def __getattr__\(self, name\):/);
});

test("installed Python runtime does not create updater-blocking bytecode", { skip: !fs.existsSync(sourceRoot) }, () => {
  const entrypoint = fs.readFileSync(path.join(sourceRoot, "runtime/bin/loudnorm-gpu-source-port"), "utf8");
  const disableBytecode = entrypoint.indexOf("sys.dont_write_bytecode = True");
  const firstLocalImport = entrypoint.indexOf("from cuda_buffers import");
  assert.ok(disableBytecode >= 0);
  assert.ok(firstLocalImport > disableBytecode);
});
