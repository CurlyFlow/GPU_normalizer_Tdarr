#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const picturesDir = path.join(repoRoot, "pictures");

const REQUIRED_TDARR_SCREENSHOTS = [
  "tdarr-flow-standalone.png",
  "tdarr-flow-3node.png",
  "tdarr-gpu-normalize-audio-ui.png",
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
    `  <style>text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }</style>`,
    `  <rect width="${width}" height="${height}" rx="14" fill="#0b1120" stroke="#1e293b" stroke-width="1.5"/>`,
    `  <text x="28" y="36" fill="#f8fafc" font-size="18" font-weight="700">GPU Normalize Audio v${esc(version)} vs. Tdarr CPU Normalize Audio</text>`,
    `  <text x="28" y="56" fill="#94a3b8" font-size="12">Combined 5.1 + generated 2ch wall time (lower is faster) · i9-9900K @ 5 GHz CPU vs. GTX 1050 Ti GPU · 100% exact decoded parity</text>`,
    `  <rect x="28" y="68" width="12" height="10" rx="2" fill="#475569"/>`,
    `  <text x="46" y="77" fill="#94a3b8" font-size="11">Tdarr CPU Reference</text>`,
    `  <rect x="180" y="68" width="12" height="10" rx="2" fill="#10b981"/>`,
    `  <text x="198" y="77" fill="#6ee7b7" font-size="11">GPU Normalize Audio v${esc(version)}</text>`,
    `  ${barsSvg}`,
    `  <text x="28" y="${height - 16}" fill="#64748b" font-size="11">Auto-generated from README.md benchmark table via scripts/generate_pictures.js</text>`,
    `</svg>`,
    "",
  ].join("\n");
}

function buildPictureMap() {
  const readmeText = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const version = parseReleaseVersion(readmeText);
  const perfRows = parsePerformanceRows(readmeText);
  return {
    "performance.svg": renderPerformanceSvg(perfRows, version),
  };
}

function checkScreenshots() {
  const missing = [];
  for (const name of REQUIRED_TDARR_SCREENSHOTS) {
    const target = path.join(picturesDir, name);
    if (!fs.existsSync(target) || fs.statSync(target).size < 1024) missing.push(name);
  }
  return missing;
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const expected = buildPictureMap();
  if (checkOnly) {
    const stale = [];
    for (const [name, content] of Object.entries(expected)) {
      const target = path.join(picturesDir, name);
      if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== content) stale.push(name);
    }
    const missingScreenshots = checkScreenshots();
    if (stale.length || missingScreenshots.length) {
      if (stale.length) {
        console.error(`pictures/ out of date (${stale.join(", ")}); run: node scripts/generate_pictures.js`);
      }
      if (missingScreenshots.length) {
        console.error(`pictures/ missing Tdarr screenshots (${missingScreenshots.join(", ")})`);
      }
      process.exit(1);
    }
    console.log(`pictures: ok (${Object.keys(expected).length} generated + ${REQUIRED_TDARR_SCREENSHOTS.length} Tdarr screenshots)`);
    return;
  }
  fs.mkdirSync(picturesDir, { recursive: true });
  for (const [name, content] of Object.entries(expected)) {
    fs.writeFileSync(path.join(picturesDir, name), content, "utf8");
  }
  console.log(`pictures: generated ${Object.keys(expected).length} files in pictures/`);
}

main();
