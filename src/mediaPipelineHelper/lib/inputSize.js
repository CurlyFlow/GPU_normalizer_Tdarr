"use strict";

const path = require("node:path");
const { lstat, readdir, realpath, stat, unlink } = require("node:fs/promises");
const { rejectInput } = require("./inputRejection");

const MEDIA_EXTENSIONS = new Set([".mkv", ".mp4", ".m4v", ".avi", ".ts", ".mov", ".m2ts", ".webm"]);

function sizeBounds(inputs = {}) {
  const minimum = Number(inputs.minFileSizeMB ?? 0);
  const maximum = Number(inputs.maxFileSizeMB ?? 50000);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)
      || minimum < 0 || maximum < 0
      || (maximum > 0 && minimum > maximum)) {
    throw new Error("Invalid input file size limits");
  }
  return { minimum: minimum * 1e6, maximum: maximum * 1e6 };
}

function isRemovableSmallFile(info, minimum) {
  return Boolean(info && info.isFile() && !info.isSymbolicLink()
    && (info.nlink === undefined || info.nlink === 1)
    && info.size < minimum);
}

async function hasValidSizedSiblingMedia(directory, selfName, minimum, { lstatFn, readdirFn }) {
  const entries = await readdirFn(directory);
  if (entries.length > 128) return false;
  for (const name of entries) {
    if (name === selfName || !MEDIA_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
    try {
      const sibling = await lstatFn(path.join(directory, name));
      if (sibling.isFile() && !sibling.isSymbolicLink() && sibling.size >= minimum) return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return false;
}

async function pruneBelowMinimumCompanion(args, fsOps = {}) {
  const bounds = sizeBounds(args.inputs);
  if (!bounds.minimum) return null;
  const source = args.originalLibraryFile?._id || args.inputFileObj?._id;
  const stagingFolder = args.librarySettings?.folder;
  if (typeof source !== "string" || !path.isAbsolute(source) || source.split(path.sep).includes("..")
      || !MEDIA_EXTENSIONS.has(path.extname(source).toLowerCase())
      || typeof stagingFolder !== "string" || !stagingFolder.trim()) {
    return null;
  }
  const lstatFn = fsOps.lstat || lstat;
  const readdirFn = fsOps.readdir || readdir;
  const unlinkFn = fsOps.unlink || unlink;
  const realpathFn = fsOps.realpath || realpath;
  const parentDir = path.dirname(source);
  try {
    const [stagingRoot, canonicalParent] = await Promise.all([
      realpathFn(stagingFolder),
      realpathFn(parentDir),
    ]);
    if (path.dirname(canonicalParent) !== stagingRoot) return null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let info;
  try {
    info = await lstatFn(source);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!isRemovableSmallFile(info, bounds.minimum)) return null;
  const hasSibling = await hasValidSizedSiblingMedia(parentDir, path.basename(source), bounds.minimum, { lstatFn, readdirFn });
  if (!hasSibling) return null;
  try {
    const current = await lstatFn(source);
    if (!isRemovableSmallFile(current, bounds.minimum)
        || (info.dev !== undefined && current.dev !== info.dev)
        || (info.ino !== undefined && current.ino !== info.ino)) {
      return null;
    }
    await unlinkFn(source);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  args.jobLog(`Media Pipeline Helper removed below-minimum companion file (${(info.size / 1e6).toFixed(2)} MB < ${args.inputs.minFileSizeMB} MB) while retaining package media; removing entry from Tdarr.`);
  return {
    outputFileObj: args.originalLibraryFile || args.inputFileObj,
    outputNumber: 2,
    variables: { ...args.variables, removeFromTdarr: true },
  };
}

async function checkInputSize(args, inspect = stat) {
  const bounds = sizeBounds(args.inputs);
  if (!bounds.minimum && !bounds.maximum) return null;
  const source = args.originalLibraryFile?._id || args.inputFileObj._id;
  const info = await inspect(source);
  if (!info.isFile()) throw new Error("Input size check requires a regular media file");
  const reason = info.size < bounds.minimum ? "belowMinimum"
    : (bounds.maximum > 0 && info.size > bounds.maximum ? "aboveMaximum" : null);
  if (!reason) return null;
  return rejectInput({ ...args, inputs: { ...args.inputs, removeRejectedFromTdarr: false } }, reason);
}

module.exports = { checkInputSize, pruneBelowMinimumCompanion, sizeBounds };
