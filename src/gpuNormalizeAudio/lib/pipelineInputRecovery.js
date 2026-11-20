"use strict";

const path = require("node:path");

class UnrecoverableInputError extends Error {
  constructor(evidence) {
    super("FFmpeg could not read the input after stream-copy repair");
    this.code = "UNRECOVERABLE_MEDIA_INPUT";
    this.evidence = evidence;
  }
}

async function recoverInput(args, runtime) {
  let previous = args.inputFileObj;
  const original = args.originalLibraryFile;
  if (original?._id && original._id !== previous._id) {
    args.jobLog("Preparing the admitted original; an upstream working cache is not original-content authority.");
    // Keep working-object DB provenance separate from immutable original authority.
    previous = { ...previous, _id: original._id, file: original._id,
      container: original.container || path.extname(original._id).slice(1).toLowerCase() };
  }
  args.jobLog("Probing current source streams before processing; cached metadata is not admission evidence.");
  let before;
  try { return await runtime.probe(previous._id, previous); }
  catch (error) {
    if (error.code !== "MEDIA_PROBE_UNREADABLE" && error.code !== "MEDIA_PROBE_BOUND") throw error;
    before = error.mediaProbe;
  }
  const recoveryArgs = { ...args, inputFileObj: previous };
  args.jobLog("Trying stream-copy input repair in the work directory; the original is unchanged.");
  const repair = { attempted: true, method: "stream-copy", originalModified: false };
  let repaired;
  try {
    repaired = await runtime.execute(recoveryArgs, { label: "Repairing input container without re-encoding",
      container: previous.container || path.extname(previous._id).slice(1).toLowerCase(),
      inputs: ["-fflags", "+genpts", "-err_detect", "ignore_err", "-i", previous._id],
      outputs: ["-map", "0", "-map_metadata", "0", "-map_chapters", "0", "-c", "copy"] });
  } catch (error) {
    if (error.code === "PIPELINE_CANCELLED") throw error;
    const readable = await runtime.readableInput(recoveryArgs);
    if (readable.readable) throw error; // A repair/output/tool failure is not proof of bad input.
    throw new UnrecoverableInputError({ mediaBefore: before, repair: { ...repair, succeeded: false },
      ffmpegRead: readable, mediaAfterExpected: { action: "native-failed-ack-then-package-cleanup", normalized: false } });
  }
  await runtime.auditRecovery(recoveryArgs, { mediaBefore: before, repair: { ...repair, succeeded: true } }, repaired);
  args.jobLog("Stream-copy repair verified and audited; normal processing continues with the working copy.");
  return repaired;
}

module.exports = { recoverInput, UnrecoverableInputError };
