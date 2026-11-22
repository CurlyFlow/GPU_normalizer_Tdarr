"use strict";

const path = require("node:path");

// The benchmark and runtime must prepare the same independent reference input.
function stereoReferenceRecipe(input, output, sourceAudioIndex, { rebasePositiveStart = false } = {}) {
  const forceMatroska = [".mov", ".mp4"].includes(path.extname(output).toLowerCase());
  const filter = rebasePositiveStart ? "aformat=channel_layouts=stereo,asetpts=N/SR/TB" : "aformat=channel_layouts=stereo";
  return {
    recipe: { kind: "stereo-source", sourceAudioIndex, filter,
      rate: 192000, codec: "pcm_f64le", container: forceMatroska ? "matroska" : "auto",
      ...(rebasePositiveStart ? { rebasePositiveStart: true } : {}) },
    args: ["-hide_banner", "-nostats", "-nostdin", "-y", "-i", input,
      "-map", `0:a:${sourceAudioIndex}`, "-vn", "-sn", "-dn", "-af", filter,
      "-ar", "192000", "-c:a", "pcm_f64le", ...(forceMatroska ? ["-f", "matroska"] : [])],
  };
}

function singleAudioReferenceRecipe(input, sourceAudioIndex, { rebasePositiveStart = false } = {}) {
  const sourceExt = path.extname(input).toLowerCase();
  const extension = [".mp4", ".mov", ".m4a"].includes(sourceExt) ? sourceExt : ".mkv";
  const container = extension === ".mkv" ? "matroska" : extension === ".mov" ? "mov" : "mp4";
  const avoidNegativeTs = rebasePositiveStart ? "make_zero" : "disabled";
  return { extension,
    recipe: { kind: "single-audio-source", sourceAudioIndex, codec: "copy", container,
      copyts: !rebasePositiveStart, avoid_negative_ts: avoidNegativeTs,
      ...(rebasePositiveStart ? { rebasePositiveStart: true } : {}) },
    args: ["-hide_banner", "-nostats", "-nostdin", "-y", ...(rebasePositiveStart ? [] : ["-copyts"]), "-i", input,
      "-map", `0:a:${sourceAudioIndex}`, "-vn", "-sn", "-dn", "-c:a", "copy",
      "-avoid_negative_ts", avoidNegativeTs, "-f", container] };
}

module.exports = { stereoReferenceRecipe, singleAudioReferenceRecipe };
