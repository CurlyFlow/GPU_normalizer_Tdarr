#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const picturesDir = path.join(repoRoot, "pictures");
const manifestPath = path.join(picturesDir, "ui-manifest.json");

const REQUIRED_TDARR_SCREENSHOTS = [
  "tdarr-flow-standalone.png",
  "tdarr-flow-3node.png",
  "tdarr-gpu-normalize-audio-ui.png",
  "tdarr-media-pipeline-helper-prepare-ui.png",
  "tdarr-media-pipeline-helper-finish-ui.png",
];

const AUDIO_SCREENSHOTS = [
  "tdarr-flow-standalone.png",
  "tdarr-flow-3node.png",
  "tdarr-gpu-normalize-audio-ui.png",
];

const HELPER_SCREENSHOTS = [
  "tdarr-flow-3node.png",
  "tdarr-media-pipeline-helper-prepare-ui.png",
  "tdarr-media-pipeline-helper-finish-ui.png",
];

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Bytes(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function parsePerformanceRows(readmeText) {
  const rows = [];
  for (const line of readmeText.split(/\r?\n/)) {
    const match = /^\|\s*\*\*(\d+\s*min)\*\*\s*\|\s*`([0-9.]+)s`\s*\|\s*\*\*`([0-9.]+)s`\*\*\s*\|\s*\*\*`([0-9.]+)x`\*\*\s*\|\s*`(-?[0-9.]+%)`\s*\|/.exec(line);
    if (!match) continue;
    rows.push({
      label: match[1],
      cpuSeconds: Number(match[2]),
      gpuSeconds: Number(match[3]),
      speedup: match[4],
      deltaVsPrev: match[5],
    });
  }
  if (!rows.length) throw new Error("Could not parse Performance table rows from README.md");
  return rows;
}

function parseReleaseVersion(readmeText) {
  const match = /badge\/release-v([0-9.]+)-/.exec(readmeText);
  return match ? match[1] : "latest";
}

function renderPerformanceSvg(rows, version) {
  const width = 980;
  const headerH = 92;
  const rowH = 74;
  const height = headerH + rows.length * rowH + 46;
  const maxSeconds = Math.max(...rows.map(r => r.cpuSeconds));
  const barX = 115;
  const barMaxW = 555;

  const barsSvg = rows.map((row, idx) => {
    const y = headerH + idx * rowH;
    const cpuW = Math.max(8, Math.round((row.cpuSeconds / maxSeconds) * barMaxW));
    const gpuW = Math.max(8, Math.round((row.gpuSeconds / maxSeconds) * barMaxW));
    return [
      `<rect x="20" y="${y}" width="${width - 40}" height="${rowH - 10}" rx="8" fill="#111827" stroke="#1e293b"/>`,
      `<text x="38" y="${y + 37}" fill="#f8fafc" font-size="15" font-weight="700">${esc(row.label)}</text>`,
      `<rect x="${barX}" y="${y + 12}" width="${cpuW}" height="16" rx="4" fill="#475569"/>`,
      `<text x="${barX + cpuW + 8}" y="${y + 24}" fill="#94a3b8" font-size="11.5">CPU ${esc(row.cpuSeconds.toFixed(1))}s</text>`,
      `<rect x="${barX}" y="${y + 34}" width="${gpuW}" height="18" rx="4" fill="#10b981"/>`,
      `<text x="${barX + gpuW + 8}" y="${y + 47}" fill="#6ee7b7" font-size="12" font-weight="700">GPU ${esc(row.gpuSeconds.toFixed(1))}s</text>`,
      `<rect x="${width - 178}" y="${y + 13}" width="144" height="38" rx="8" fill="#064e3b" stroke="#10b981" stroke-width="1"/>`,
      `<text x="${width - 106}" y="${y + 30}" text-anchor="middle" fill="#a7f3d0" font-size="13.5" font-weight="700">${esc(row.speedup)}x vs CPU</text>`,
      `<text x="${width - 106}" y="${y + 45}" text-anchor="middle" fill="#6ee7b7" font-size="10.5">${esc(row.deltaVsPrev)} vs prev · 100% parity</text>`,
    ].join("\n  ");
  }).join("\n  ");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="GPU Normalize Audio Performance vs Tdarr CPU Reference">`,
    '  <style>text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }</style>',
    `  <rect width="${width}" height="${height}" rx="14" fill="#0b1120" stroke="#1e293b" stroke-width="1.5"/>`,
    `  <text x="28" y="36" fill="#f8fafc" font-size="18" font-weight="700">GPU Normalize Audio v${esc(version)} vs. Tdarr CPU Normalize Audio</text>`,
    '  <text x="28" y="56" fill="#94a3b8" font-size="12">Combined 5.1 + generated 2ch wall time (lower is faster) · i9-9900K @ 5 GHz CPU vs. GTX 1050 Ti GPU · 100% exact decoded parity</text>',
    '  <rect x="28" y="68" width="12" height="10" rx="2" fill="#475569"/>',
    '  <text x="46" y="77" fill="#94a3b8" font-size="11">Tdarr CPU Reference</text>',
    '  <rect x="180" y="68" width="12" height="10" rx="2" fill="#10b981"/>',
    `  <text x="198" y="77" fill="#6ee7b7" font-size="11">GPU Normalize Audio v${esc(version)}</text>`,
    `  ${barsSvg}`,
    `  <text x="28" y="${height - 16}" fill="#64748b" font-size="11">Auto-generated from README.md benchmark table via scripts/generate_pictures.js</text>`,
    "</svg>",
    "",
  ].join("\n");
}

function buildPictureMap(readmeText = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8")) {
  const version = parseReleaseVersion(readmeText);
  const perfRows = parsePerformanceRows(readmeText);
  return {
    "performance.svg": renderPerformanceSvg(perfRows, version),
  };
}

function loadFreshDetails(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved).details();
}

function computeUiHashes(versionOverride = null) {
  const readmeText = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const releaseVersion = versionOverride || parseReleaseVersion(readmeText);
  const audioDetails = loadFreshDetails(path.join(repoRoot, "src/gpuNormalizeAudio/lib/pluginDetails.js"));
  const helperDetails = loadFreshDetails(path.join(repoRoot, "src/mediaPipelineHelper/lib/mediaPipelineDetails.js"));
  return {
    releaseVersion,
    audioUiSha256: sha256Bytes(Buffer.from(canonicalJson({ releaseVersion, details: audioDetails }), "utf8")),
    helperUiSha256: sha256Bytes(Buffer.from(canonicalJson({ details: helperDetails }), "utf8")),
  };
}

function readUiManifest(file = manifestPath) {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function inspectPicturesState(versionOverride = null, options = {}) {
  const targetDir = options.picturesDir || picturesDir;
  const targetManifestPath = path.join(targetDir, "ui-manifest.json");
  const expected = buildPictureMap();
  const staleGenerated = [];
  for (const [name, content] of Object.entries(expected)) {
    const target = path.join(targetDir, name);
    if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== content) staleGenerated.push(name);
  }
  const currentUi = options.uiHashes || computeUiHashes(versionOverride);
  const recorded = readUiManifest(targetManifestPath);
  const missingManifest = !recorded || recorded.schema !== "pictures-ui-manifest.v1";
  const releaseVersionChanged = missingManifest || recorded.releaseVersion !== currentUi.releaseVersion;
  const audioUiChanged = missingManifest || recorded.audioUiSha256 !== currentUi.audioUiSha256;
  const helperUiChanged = missingManifest || recorded.helperUiSha256 !== currentUi.helperUiSha256;

  const missingScreenshots = [];
  const modifiedScreenshots = [];
  const actualScreenshotHashes = {};
  for (const name of REQUIRED_TDARR_SCREENSHOTS) {
    const target = path.join(targetDir, name);
    if (!fs.existsSync(target) || fs.statSync(target).size < 1024) {
      missingScreenshots.push(name);
      continue;
    }
    const digest = sha256File(target);
    actualScreenshotHashes[name] = digest;
    if (!missingManifest && recorded.screenshots?.[name] !== digest) {
      modifiedScreenshots.push(name);
    }
  }

  const staleScreenshots = new Set([...missingScreenshots, ...modifiedScreenshots]);
  if (audioUiChanged || releaseVersionChanged) AUDIO_SCREENSHOTS.forEach(name => staleScreenshots.add(name));
  if (helperUiChanged) HELPER_SCREENSHOTS.forEach(name => staleScreenshots.add(name));

  return {
    staleGenerated,
    missingManifest,
    releaseVersionChanged,
    audioUiChanged,
    helperUiChanged,
    missingScreenshots,
    modifiedScreenshots,
    staleScreenshots: REQUIRED_TDARR_SCREENSHOTS.filter(name => staleScreenshots.has(name)),
    screenshotsStale: staleScreenshots.size > 0 || missingManifest,
    currentUi,
    actualScreenshotHashes,
  };
}

function writeUiManifest(versionOverride = null, options = {}) {
  const targetDir = options.picturesDir || picturesDir;
  const targetManifestPath = path.join(targetDir, "ui-manifest.json");
  const currentUi = options.uiHashes || computeUiHashes(versionOverride);
  const screenshots = {};
  for (const name of REQUIRED_TDARR_SCREENSHOTS) {
    const target = path.join(targetDir, name);
    if (!fs.existsSync(target) || fs.statSync(target).size < 1024) {
      throw new Error(`Cannot write ui-manifest.json: missing or invalid screenshot ${name}`);
    }
    screenshots[name] = sha256File(target);
  }
  const manifest = {
    schema: "pictures-ui-manifest.v1",
    releaseVersion: currentUi.releaseVersion,
    audioUiSha256: currentUi.audioUiSha256,
    helperUiSha256: currentUi.helperUiSha256,
    screenshots,
  };
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function main() {
  const args = process.argv.slice(2);
  const versionFlagIndex = args.indexOf("--version");
  const versionOverride = versionFlagIndex >= 0 ? args[versionFlagIndex + 1] : null;
  if (args.includes("--status-json")) {
    console.log(JSON.stringify(inspectPicturesState(versionOverride), null, 2));
    return;
  }
  if (args.includes("--write-manifest")) {
    const manifest = writeUiManifest(versionOverride);
    console.log(`pictures: updated ui-manifest.json (v${manifest.releaseVersion}, audio=${manifest.audioUiSha256.slice(0, 8)}, helper=${manifest.helperUiSha256.slice(0, 8)})`);
    return;
  }
  if (args.includes("--check")) {
    const state = inspectPicturesState(versionOverride);
    const errors = [];
    if (state.staleGenerated.length) {
      errors.push(`generated SVGs out of date (${state.staleGenerated.join(", ")}); run: node scripts/generate_pictures.js`);
    }
    if (state.missingManifest) {
      errors.push("pictures/ui-manifest.json missing or invalid; capture screenshots and run: node scripts/generate_pictures.js --write-manifest");
    } else {
      if (state.audioUiChanged) errors.push("GPU Normalize Audio UI schema or release version changed; recapture Tdarr screenshots");
      if (state.helperUiChanged) errors.push("Media Pipeline Helper UI schema changed; recapture Tdarr screenshots");
      if (state.missingScreenshots.length) errors.push(`missing Tdarr screenshots (${state.missingScreenshots.join(", ")})`);
      if (state.modifiedScreenshots.length) errors.push(`Tdarr screenshots differ from ui-manifest.json (${state.modifiedScreenshots.join(", ")})`);
    }
    if (errors.length) {
      for (const msg of errors) console.error(`pictures: ${msg}`);
      process.exit(1);
    }
    console.log(`pictures: ok (1 generated + ${REQUIRED_TDARR_SCREENSHOTS.length} Tdarr screenshots, audio=${state.currentUi.audioUiSha256.slice(0, 8)}, helper=${state.currentUi.helperUiSha256.slice(0, 8)})`);
    return;
  }
  const expected = buildPictureMap();
  fs.mkdirSync(picturesDir, { recursive: true });
  let updated = 0;
  for (const [name, content] of Object.entries(expected)) {
    const target = path.join(picturesDir, name);
    if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== content) {
      fs.writeFileSync(target, content, "utf8");
      updated += 1;
    }
  }
  console.log(updated
    ? `pictures: updated ${updated} generated file(s) in pictures/`
    : "pictures: performance.svg already up to date");
}

if (require.main === module) {
  main();
}

module.exports = {
  REQUIRED_TDARR_SCREENSHOTS,
  AUDIO_SCREENSHOTS,
  HELPER_SCREENSHOTS,
  parseReleaseVersion,
  computeUiHashes,
  inspectPicturesState,
  writeUiManifest,
};
