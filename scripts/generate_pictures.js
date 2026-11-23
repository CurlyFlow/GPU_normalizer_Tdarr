#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const picturesDir = path.join(repoRoot, "pictures");

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(text, maxChars) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}

function badgeColor(phaseHint) {
  if (phaseHint === "prepare") return { bg: "#1e3a5f", stroke: "#38bdf8", text: "#7dd3fc" };
  if (phaseHint === "finish") return { bg: "#3b1f4e", stroke: "#c084fc", text: "#e9d5ff" };
  if (phaseHint === "shared") return { bg: "#1f3a2e", stroke: "#34d399", text: "#a7f3d0" };
  return { bg: "#263042", stroke: "#64748b", text: "#cbd5e1" };
}

function inferPhaseBadge(input) {
  const tip = String(input.tooltip || "");
  if (input.inputUI?.displayConditions) return { label: "prepare · inherited", kind: "shared" };
  if (/^Prepare:/i.test(tip)) return { label: "prepare", kind: "prepare" };
  if (/^Finish/i.test(tip)) return { label: "finish", kind: "finish" };
  if (/^Required:/i.test(tip)) return { label: "prepare + finish", kind: "shared" };
  return null;
}

function renderControl(input, x, y) {
  const uiType = input.inputUI?.type || "text";
  const val = input.defaultValue;
  if (uiType === "switch") {
    const on = val === true || val === "true";
    const trackFill = on ? "#10b981" : "#334155";
    const knobX = on ? x + 28 : x + 6;
    const stateText = on ? "ON" : "OFF";
    const stateColor = on ? "#6ee7b7" : "#94a3b8";
    return [
      `<rect x="${x}" y="${y + 4}" width="44" height="22" rx="11" fill="${trackFill}"/>`,
      `<circle cx="${knobX + 5}" cy="${y + 15}" r="8" fill="#f8fafc"/>`,
      `<text x="${x + 54}" y="${y + 19}" fill="${stateColor}" font-size="11.5" font-weight="600">${stateText}</text>`,
    ].join("");
  }
  const display = val === "" ? "(empty)" : String(val);
  const textColor = val === "" ? "#64748b" : "#e2e8f0";
  const boxWidth = 230;
  const suffix = uiType === "dropdown" ? `<text x="${x + boxWidth - 18}" y="${y + 19}" fill="#94a3b8" font-size="11">▾</text>` : "";
  return [
    `<rect x="${x}" y="${y + 1}" width="${boxWidth}" height="26" rx="6" fill="#0b1220" stroke="#334155" stroke-width="1"/>`,
    `<text x="${x + 10}" y="${y + 18}" fill="${textColor}" font-size="12" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${esc(truncate(display, 26))}</text>`,
    suffix,
  ].join("");
}

function renderInputRow(input, index, startY, width, showPhaseBadges) {
  const rowH = 48;
  const y = startY + index * rowH;
  const bg = index % 2 === 0 ? "#111827" : "#0f172a";
  const badge = showPhaseBadges ? inferPhaseBadge(input) : null;
  let badgeSvg = "";
  let labelMax = 44;
  if (badge) {
    const c = badgeColor(badge.kind);
    const bw = Math.max(58, Math.round(badge.label.length * 6.5 + 16));
    const bx = width - 282 - bw;
    labelMax = 42;
    badgeSvg = [
      `<rect x="${bx}" y="${y + 7}" width="${bw}" height="18" rx="9" fill="${c.bg}" stroke="${c.stroke}" stroke-width="0.8"/>`,
      `<text x="${bx + bw / 2}" y="${y + 19}" text-anchor="middle" fill="${c.text}" font-size="10" font-weight="600">${esc(badge.label)}</text>`,
    ].join("");
  }
  return [
    `<rect x="20" y="${y}" width="${width - 40}" height="${rowH - 4}" rx="7" fill="${bg}" stroke="#1e293b" stroke-width="1"/>`,
    `<text x="34" y="${y + 19}" fill="#f1f5f9" font-size="13" font-weight="600">${esc(truncate(input.label, labelMax))}</text>`,
    `<text x="34" y="${y + 35}" fill="#94a3b8" font-size="11">${esc(truncate(input.tooltip, 88))}</text>`,
    badgeSvg,
    renderControl(input, width - 266, y + 8),
  ].join("\n  ");
}

function renderPluginUiSvg(details, options = {}) {
  const width = 980;
  const headerH = 92;
  const rowH = 48;
  const inputs = details.inputs || [];
  const outputs = details.outputs || [];
  const accent = details.style?.borderColor || "#38bdf8";
  const bodyY = headerH + 14;
  const outputsY = bodyY + inputs.length * rowH + 10;
  const footerH = 26 + outputs.length * 24 + 18;
  const height = outputsY + footerH;
  const subtitle = options.subtitle || "Tdarr FlowPlugin · LocalFlowPlugins";

  const rowsSvg = inputs
    .map((input, index) => renderInputRow(input, index, bodyY, width, Boolean(options.showPhaseBadges)))
    .join("\n  ");

  const outputsSvg = outputs.map((out, idx) => {
    const oy = outputsY + 30 + idx * 24;
    return [
      `<rect x="34" y="${oy - 13}" width="68" height="18" rx="9" fill="#1e293b" stroke="${accent}" stroke-width="0.9"/>`,
      `<text x="68" y="${oy - 1}" text-anchor="middle" fill="#e2e8f0" font-size="10.5" font-weight="600">Output ${esc(out.number)}</text>`,
      `<text x="112" y="${oy - 1}" fill="#cbd5e1" font-size="11.5">${esc(truncate(out.tooltip, 112))}</text>`,
    ].join("");
  }).join("\n  ");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(details.name)} Plugin UI">`,
    `  <style>text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }</style>`,
    `  <rect width="${width}" height="${height}" rx="14" fill="#0b1120" stroke="#1e293b" stroke-width="1.5"/>`,
    `  <rect x="0" y="0" width="${width}" height="4" rx="2" fill="${accent}"/>`,
    `  <rect x="20" y="18" width="${width - 40}" height="68" rx="10" fill="#111827" stroke="${accent}" stroke-width="1.2"/>`,
    `  <circle cx="44" cy="44" r="7" fill="${accent}"/>`,
    `  <text x="60" y="49" fill="#f8fafc" font-size="20" font-weight="700">${esc(details.name)}</text>`,
    `  <text x="${width - 34}" y="47" text-anchor="end" fill="#94a3b8" font-size="12" font-weight="600">${esc(subtitle)}</text>`,
    `  <text x="34" y="72" fill="#94a3b8" font-size="12">${esc(truncate(details.description, 128))}</text>`,
    `  ${rowsSvg}`,
    `  <rect x="20" y="${outputsY}" width="${width - 40}" height="${footerH - 14}" rx="9" fill="#111827" stroke="#1e293b" stroke-width="1"/>`,
    `  <text x="34" y="${outputsY + 18}" fill="#94a3b8" font-size="11" font-weight="700" letter-spacing="0.06em">FLOW OUTPUTS</text>`,
    `  ${outputsSvg}`,
    `</svg>`,
    "",
  ].join("\n");
}

function renderPipelineFlowSvg() {
  const width = 980;
  const height = 430;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Tdarr Flow Topology: Standalone vs 3-Node Integrity Pipeline">`,
    `  <defs>`,
    `    <marker id="arrow-cyan" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8"/></marker>`,
    `    <marker id="arrow-purple" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="#a78bfa"/></marker>`,
    `    <marker id="arrow-green" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="#34d399"/></marker>`,
    `    <marker id="arrow-rose" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="#fb7185"/></marker>`,
    `  </defs>`,
    `  <style>text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }</style>`,
    `  <rect width="${width}" height="${height}" rx="14" fill="#0b1120" stroke="#1e293b" stroke-width="1.5"/>`,
    `  <text x="28" y="36" fill="#f8fafc" font-size="18" font-weight="700">Tdarr Flow Topologies</text>`,
    `  <text x="28" y="55" fill="#94a3b8" font-size="12">Use GPU Normalize Audio standalone, or wrap it with Media Pipeline Helper (prepare + finish) for end-to-end integrity.</text>`,
    `  <!-- Mode 1: Standalone -->`,
    `  <rect x="24" y="72" width="${width - 48}" height="104" rx="10" fill="#111827" stroke="#1e293b" stroke-width="1"/>`,
    `  <text x="40" y="94" fill="#38bdf8" font-size="12" font-weight="700" letter-spacing="0.05em">1. STANDALONE NORMALIZER FLOW</text>`,
    `  <rect x="44" y="108" width="170" height="50" rx="8" fill="#0f172a" stroke="#475569"/>`,
    `  <text x="129" y="130" text-anchor="middle" fill="#e2e8f0" font-size="13" font-weight="600">Input File</text>`,
    `  <text x="129" y="147" text-anchor="middle" fill="#94a3b8" font-size="11">Any MKV / MP4 / MOV</text>`,
    `  <line x1="214" y1="133" x2="310" y2="133" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow-cyan)"/>`,
    `  <rect x="316" y="104" width="320" height="58" rx="9" fill="#0f172a" stroke="#38bdf8" stroke-width="1.8"/>`,
    `  <text x="476" y="128" text-anchor="middle" fill="#f8fafc" font-size="14" font-weight="700">GPU Normalize Audio</text>`,
    `  <text x="476" y="147" text-anchor="middle" fill="#7dd3fc" font-size="11">CUDA loudnorm · +2ch fallback · direct clock mux</text>`,
    `  <line x1="636" y1="133" x2="736" y2="133" stroke="#34d399" stroke-width="2" marker-end="url(#arrow-green)"/>`,
    `  <text x="686" y="125" text-anchor="middle" fill="#6ee7b7" font-size="10.5" font-weight="600">Out 1</text>`,
    `  <rect x="742" y="108" width="194" height="50" rx="8" fill="#0f172a" stroke="#34d399"/>`,
    `  <text x="839" y="130" text-anchor="middle" fill="#e2e8f0" font-size="13" font-weight="600">Replace / Next Node</text>`,
    `  <text x="839" y="147" text-anchor="middle" fill="#94a3b8" font-size="11">100% decoded CPU parity</text>`,
    `  <!-- Mode 2: 3-Node Pipeline -->`,
    `  <rect x="24" y="192" width="${width - 48}" height="218" rx="10" fill="#111827" stroke="#1e293b" stroke-width="1"/>`,
    `  <text x="40" y="214" fill="#c084fc" font-size="12" font-weight="700" letter-spacing="0.05em">2. FULL 3-NODE PIPELINE (ORIGINAL-RELATIVE INTEGRITY + ARR HANDOFF)</text>`,
    `  <!-- Prepare -->`,
    `  <rect x="44" y="232" width="246" height="86" rx="9" fill="#0f172a" stroke="#a78bfa" stroke-width="1.8"/>`,
    `  <text x="167" y="255" text-anchor="middle" fill="#f8fafc" font-size="13.5" font-weight="700">Media Pipeline Helper</text>`,
    `  <text x="167" y="272" text-anchor="middle" fill="#c084fc" font-size="11.5" font-weight="600">phase = prepare</text>`,
    `  <text x="167" y="290" text-anchor="middle" fill="#94a3b8" font-size="10.5">Admission · cleanup · SRT extract</text>`,
    `  <text x="167" y="305" text-anchor="middle" fill="#7dd3fc" font-size="10.5">Sets global CPU &amp; GPU limits</text>`,
    `  <!-- Audio -->`,
    `  <rect x="366" y="232" width="248" height="86" rx="9" fill="#0f172a" stroke="#38bdf8" stroke-width="1.8"/>`,
    `  <text x="490" y="255" text-anchor="middle" fill="#f8fafc" font-size="13.5" font-weight="700">GPU Normalize Audio</text>`,
    `  <text x="490" y="272" text-anchor="middle" fill="#7dd3fc" font-size="11.5" font-weight="600">CUDA 2-pass · AAC-LC</text>`,
    `  <text x="490" y="290" text-anchor="middle" fill="#94a3b8" font-size="10.5">Releases GPU before CPU finalize</text>`,
    `  <text x="490" y="305" text-anchor="middle" fill="#94a3b8" font-size="10.5">Verified clock transport &amp; handoff</text>`,
    `  <!-- Finish -->`,
    `  <rect x="690" y="232" width="246" height="86" rx="9" fill="#0f172a" stroke="#34d399" stroke-width="1.8"/>`,
    `  <text x="813" y="255" text-anchor="middle" fill="#f8fafc" font-size="13.5" font-weight="700">Media Pipeline Helper</text>`,
    `  <text x="813" y="272" text-anchor="middle" fill="#6ee7b7" font-size="11.5" font-weight="600">phase = finish</text>`,
    `  <text x="813" y="290" text-anchor="middle" fill="#94a3b8" font-size="10.5">HEVC NVENC/copy · SRT embed</text>`,
    `  <text x="813" y="305" text-anchor="middle" fill="#94a3b8" font-size="10.5">Complete verify · publish · Arr notify</text>`,
    `  <!-- Primary edges -->`,
    `  <line x1="290" y1="275" x2="360" y2="275" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow-cyan)"/>`,
    `  <text x="325" y="267" text-anchor="middle" fill="#7dd3fc" font-size="10.5" font-weight="600">Out 1</text>`,
    `  <line x1="614" y1="275" x2="684" y2="275" stroke="#34d399" stroke-width="2" marker-end="url(#arrow-green)"/>`,
    `  <text x="649" y="267" text-anchor="middle" fill="#6ee7b7" font-size="10.5" font-weight="600">Out 1/2</text>`,
    `  <!-- Output 3 checkpoint resume bypass -->`,
    `  <path d="M 210 318 L 210 350 L 760 350 L 760 324" fill="none" stroke="#a78bfa" stroke-width="1.8" stroke-dasharray="6 4" marker-end="url(#arrow-purple)"/>`,
    `  <text x="485" y="344" text-anchor="middle" fill="#d8b4fe" font-size="10.5" font-weight="600">Out 3: verified finished checkpoint resume (skips re-normalize &amp; re-encode)</text>`,
    `  <!-- Output 2 audited rejection -->`,
    `  <path d="M 110 318 L 110 382 L 320 382" fill="none" stroke="#fb7185" stroke-width="1.8" marker-end="url(#arrow-rose)"/>`,
    `  <text x="330" y="386" fill="#fda4af" font-size="11" font-weight="600">Out 2: confirmed rejection (size / unreadable / audio policy) → audited cleanup</text>`,
    `</svg>`,
    "",
  ].join("\n");
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
    `  <text x="28" y="${height - 16}" fill="#64748b" font-size="11">Auto-generated from README.md benchmark table &amp; plugin metadata via scripts/generate_pictures.js</text>`,
    `</svg>`,
    "",
  ].join("\n");
}

function buildPictureMap() {
  const normalizer = require(path.join(repoRoot, "src/gpuNormalizeAudio/lib/pluginDetails.js"));
  const helper = require(path.join(repoRoot, "src/mediaPipelineHelper/lib/mediaPipelineDetails.js"));
  const readmeText = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const version = parseReleaseVersion(readmeText);
  const perfRows = parsePerformanceRows(readmeText);
  return {
    "gpu-normalize-audio-ui.svg": renderPluginUiSvg(normalizer.details(), {
      subtitle: `Tdarr FlowPlugin · v${version} · Standalone or 3-Node`,
      showPhaseBadges: false,
    }),
    "media-pipeline-helper-ui.svg": renderPluginUiSvg(helper.details(), {
      subtitle: "Tdarr FlowPlugin · Companion Prepare / Finish Node",
      showPhaseBadges: true,
    }),
    "pipeline-flow.svg": renderPipelineFlowSvg(),
    "performance.svg": renderPerformanceSvg(perfRows, version),
  };
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
    if (stale.length) {
      console.error(`pictures/ out of date (${stale.join(", ")}); run: node scripts/generate_pictures.js`);
      process.exit(1);
    }
    console.log(`pictures: ok (${Object.keys(expected).length} files in sync)`);
    return;
  }
  fs.mkdirSync(picturesDir, { recursive: true });
  for (const [name, content] of Object.entries(expected)) {
    fs.writeFileSync(path.join(picturesDir, name), content, "utf8");
  }
  console.log(`pictures: generated ${Object.keys(expected).length} files in pictures/`);
}

main();
