"use strict";

const { stat } = require("node:fs/promises");
const { rejectInput } = require("./inputRejection");

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

module.exports = { checkInputSize, sizeBounds };
