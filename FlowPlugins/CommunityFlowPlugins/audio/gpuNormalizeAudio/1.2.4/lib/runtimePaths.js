"use strict";

const fs = require("fs");

function missingRuntime(label, path) {
  return new Error(`${label} not found: ${path}. Install the GPU loudnorm runtime bundle in the Tdarr container or set the plugin input to the correct path.`);
}

function ensureReadableRuntime(label, path) {
  if (!fs.existsSync(path)) throw missingRuntime(label, path);
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile()) throw new Error(`${label} is not a file: ${path}`);
    fs.accessSync(path, fs.constants.R_OK);
  } catch (err) {
    throw new Error(`${label} is not readable: ${path}. Tdarr may have installed the runtime helper with invalid permissions; reinstall or repair the plugin package. ${err.message}`);
  }
}

function ensureExecutableRuntime(label, path) {
  if (!fs.existsSync(path)) throw missingRuntime(label, path);
  try {
    fs.accessSync(path, fs.constants.X_OK);
    return;
  } catch (_) {
    // Tdarr/plugin extraction can drop executable bits even when the release package has them.
  }
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile()) throw new Error(`${label} is not a file: ${path}`);
    fs.chmodSync(path, stat.mode | 0o111);
    fs.accessSync(path, fs.constants.X_OK);
  } catch (err) {
    throw new Error(`${label} is not executable: ${path}. Tdarr may have installed the runtime helper without executable permissions; fix the helper permissions or reinstall the plugin package. ${err.message}`);
  }
}

module.exports = {
  ensureExecutableRuntime,
  ensureReadableRuntime,
};
