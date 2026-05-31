"use strict";

const fs = require("fs");

function parseLoudnormJson(text) {
  const full = String(text || "");
  const targetOffsetIdx = full.lastIndexOf("target_offset");
  if (targetOffsetIdx === -1) throw new Error("Failed to find target_offset in loudnorm output");
  const closingBraceIdx = full.indexOf("}", targetOffsetIdx);
  if (closingBraceIdx === -1) throw new Error("Failed to find closing brace in loudnorm output");
  const openingBraceIdx = full.lastIndexOf("{", targetOffsetIdx);
  if (openingBraceIdx === -1) throw new Error("Failed to find opening brace in loudnorm output");
  return JSON.parse(full.slice(openingBraceIdx, closingBraceIdx + 1));
}

function parseLoudnormJsonBlocks(text) {
  const full = String(text || "");
  const blocks = [];
  let searchFrom = 0;
  while (true) {
    const targetOffsetIdx = full.indexOf("target_offset", searchFrom);
    if (targetOffsetIdx === -1) break;
    const closingBraceIdx = full.indexOf("}", targetOffsetIdx);
    if (closingBraceIdx === -1) break;
    const openingBraceIdx = full.lastIndexOf("{", targetOffsetIdx);
    if (openingBraceIdx === -1) break;
    blocks.push(JSON.parse(full.slice(openingBraceIdx, closingBraceIdx + 1)));
    searchFrom = closingBraceIdx + 1;
  }
  return blocks;
}

function parseLoudnormJsonFromOutputOrFile(outputText, fallbackPath) {
  let loudnormText = String(outputText || "");
  if (!loudnormText.includes("target_offset") && fallbackPath && fs.existsSync(fallbackPath)) {
    loudnormText = fs.readFileSync(fallbackPath, "utf8");
  }
  return parseLoudnormJson(loudnormText);
}

function parseLoudnormJsonBlocksFromOutputs(outputText, fallbackPaths) {
  let loudnormText = String(outputText || "");
  for (const loudnormPath of fallbackPaths || []) {
    if (loudnormPath && fs.existsSync(loudnormPath)) {
      loudnormText += `\n${fs.readFileSync(loudnormPath, "utf8")}`;
    }
  }
  return parseLoudnormJsonBlocks(loudnormText);
}

function loudnormNumber(values, key) {
  const parsed = Number.parseFloat(String((values || {})[key]));
  if (!Number.isFinite(parsed)) throw new Error(`GPU normalize: invalid loudnorm ${key}`);
  return parsed;
}

module.exports = {
  loudnormNumber,
  parseLoudnormJson,
  parseLoudnormJsonBlocks,
  parseLoudnormJsonBlocksFromOutputs,
  parseLoudnormJsonFromOutputOrFile,
};
