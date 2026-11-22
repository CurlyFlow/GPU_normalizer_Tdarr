"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const sourceRoot = process.env.QUALITY_SKIP_LOCAL_SOURCE === "1"
  ? path.join(repoRoot, ".quality-source-not-present")
  : path.join(repoRoot, "src/gpuNormalizeAudio");

test("private operators, media evidence and docs stay outside public Git", () => {
  const paths = ["private/mediaPipelineHelper/fixture.js", "tools/private-fixture.mjs", "docs/private-fixture.md",
    "work/private-media-fixture.mkv", "work/rollout/private-fixture.json", ".agents/private-fixture.json"];
  const result = spawnSync("git", ["check-ignore", "--", ...paths],
    { cwd: repoRoot, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), paths);
});

test("release privacy scan does not skip binary artifacts", () => {
  const temporary = fs.mkdtempSync(path.join(repoRoot, "work/privacy-contract-"));
  try {
    const artifact = path.join(temporary, "fixture.so");
    fs.writeFileSync(artifact, Buffer.from("\0password=fixture-not-a-secret\0"));
    const result = spawnSync("python3", ["scripts/release_snapshot_policy.py", "scan", temporary],
      { cwd: repoRoot, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /private-term scan failed/);
    fs.writeFileSync(artifact, Buffer.from("\0ordinary native payload\0"));
    const clean = spawnSync("python3", ["scripts/release_snapshot_policy.py", "scan", temporary],
      { cwd: repoRoot, encoding: "utf8", timeout: 10000 });
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("release privacy scan blocks full release names and redacts local env terms", () => {
  const temporary = fs.mkdtempSync(path.join(repoRoot, "work/privacy-env-contract-"));
  const scanDir = path.join(temporary, "payload");
  const envFile = path.join(temporary, ".env.fixture");
  const payload = path.join(scanDir, "sample.txt");
  const runScan = (env) => spawnSync("python3", ["scripts/release_snapshot_policy.py", "scan", scanDir],
    { cwd: repoRoot, encoding: "utf8", timeout: 10000, env });
  try {
    fs.mkdirSync(scanDir, { recursive: true });
    fs.writeFileSync(envFile, "PRIVACY_EXTRA_TERMS=secretLocalHostFixture\n");
    const env = { ...process.env, PRIVACY_ENV_FILE: envFile, PRIVACY_EXTRA_TERMS: "" };
    fs.writeFileSync(payload, "Generic 2160p WEBRip and S01E02 notes are fine.\n");
    assert.equal(runScan(env).status, 0);
    fs.writeFileSync(payload, "Example.Title.2160p.WEBRip.H265-RLSGROUP\n");
    assert.equal(runScan(env).status, 1);
    fs.writeFileSync(payload, "connecting to secretLocalHostFixture\n");
    const envHit = runScan(env);
    assert.equal(envHit.status, 1);
    assert.doesNotMatch(envHit.stderr, /secretLocalHostFixture/);
    assert.match(envHit.stderr, /local-env-term \(redacted\)/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("source lint rejects unresolved context fields and permits real Node globals", () => {
  const eslint = path.join(repoRoot, "node_modules/eslint/bin/eslint.js");
  for (const [input, expected] of [
    ["module.exports = missingProcessingContext;", 1],
    ["module.exports = () => clearTimeout(setTimeout(() => {}, 1));", 0],
  ]) {
    const result = spawnSync(process.execPath, [eslint, "--stdin", "--stdin-filename", "src/gpuNormalizeAudio/lib/lintFixture.js"],
      { cwd: repoRoot, input, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, expected, result.stdout + result.stderr);
    if (expected) assert.match(result.stdout, /no-undef/);
  }
});

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
  const candidates = [
    "FlowPlugins/LocalFlowPlugins/audio/gpuNormalizeAudio",
    "FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio",
  ].flatMap((rel) => {
    const base = path.join(repoRoot, rel);
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ version: entry.name, dir: path.join(base, entry.name) }));
  }).sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  const latestReleaseDir = candidates.at(-1)?.dir;
  for (const root of [latestReleaseDir, sourceRoot].filter((dir) => dir && fs.existsSync(dir))) {
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
  assert.doesNotMatch(runtimeConfig, /def __getattr__\(/);
});

test("installed Python runtime does not create updater-blocking bytecode", { skip: !fs.existsSync(sourceRoot) }, () => {
  const entrypoint = fs.readFileSync(path.join(sourceRoot, "runtime/bin/loudnorm-gpu-source-port"), "utf8");
  const disableBytecode = entrypoint.indexOf("sys.dont_write_bytecode = True");
  const firstLocalImport = entrypoint.indexOf("from cuda_buffers import");
  assert.ok(disableBytecode >= 0);
  assert.ok(firstLocalImport > disableBytecode);
});

test("dependency owner rules reject reverse imports but allow shared policy", { skip: !fs.existsSync(sourceRoot) }, () => {
  const root = fs.mkdtempSync(path.join(repoRoot, "work/ownership-contract-"));
  const lib = path.join(root, "src/gpuNormalizeAudio/lib");
  fs.mkdirSync(lib, { recursive: true });
  const cases = [
    ["outputMux", "pluginProcessingContext", "output-data-and-command-policy-stay-below-orchestration"],
    ["splitStatsCoordinator", "pairedApplyCoordinator", "stats-does-not-own-processing-or-publication"],
    ["pairedApplyCoordinator", "cpuLoudnormScheduler", "paired-apply-does-not-own-stats-scheduling"],
    ["pairedApplyMeasurement", "cpuLoudnormTelemetry", null],
    ["pairedApplySplitStats", "splitStatsPolicy", null],
  ];
  try {
    for (const [owner, dependency, violation] of cases) {
      const ownerPath = path.join(lib, `${owner}.js`);
      const dependencyPath = path.join(lib, `${dependency}.js`);
      fs.writeFileSync(ownerPath, `module.exports = require("./${dependency}");\n`);
      fs.writeFileSync(dependencyPath, "module.exports = {};\n");
      const result = spawnSync(process.execPath, [
        path.join(repoRoot, "node_modules/dependency-cruiser/bin/dependency-cruise.mjs"),
        "src/gpuNormalizeAudio/lib", "--config", path.join(repoRoot, ".dependency-cruiser.cjs"),
        "--output-type", "err",
      ], { cwd: root, encoding: "utf8", timeout: 15000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, violation ? 1 : 0, `${result.stdout}\n${result.stderr}`);
      if (violation) assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(violation));
      fs.unlinkSync(ownerPath);
      fs.unlinkSync(dependencyPath);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("source size gate checks explicit files and rejects missing inputs", { skip: !fs.existsSync(sourceRoot) }, () => {
  const root = fs.mkdtempSync(path.join(repoRoot, "work/source-size-contract-"));
  const file = path.join(root, "fixture.mjs");
  const run = (...inputs) => spawnSync("python3", [path.join(repoRoot, "scripts/source-quality.py"), ...inputs], {
    cwd: repoRoot, encoding: "utf8", timeout: 15000,
    env: { ...process.env, SOURCE_QUALITY_MAX_LINES: "1000" },
  });
  try {
    fs.writeFileSync(file, "export const value = 1;\n");
    assert.equal(run(file).status, 0);
    assert.equal(run(file, path.join(root, "missing.js")).status, 1);
    fs.writeFileSync(file, "// fixture\n".repeat(1000));
    assert.equal(run(file).status, 0);
    fs.writeFileSync(file, "// fixture\n".repeat(1001));
    const oversized = run(file);
    assert.equal(oversized.status, 1);
    assert.match(oversized.stderr, /exceeds 1000/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
