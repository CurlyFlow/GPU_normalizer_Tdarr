"use strict";

const path = require("node:path");

// The benchmark and runtime must prepare the same independent reference input.
function stereoReferenceRecipe(input, output, sourceAudioIndex) {
  const forceMatroska = [".mov", ".mp4"].includes(path.extname(output).toLowerCase());
  return {
    recipe: { kind: "stereo-source", sourceAudioIndex, filter: "aformat=channel_layouts=stereo",
      rate: 192000, codec: "pcm_f64le", container: forceMatroska ? "matroska" : "auto" },
    args: ["-hide_banner", "-nostats", "-nostdin", "-y", "-i", input,
      "-map", `0:a:${sourceAudioIndex}`, "-vn", "-sn", "-dn", "-af", "aformat=channel_layouts=stereo",
      "-ar", "192000", "-c:a", "pcm_f64le", ...(forceMatroska ? ["-f", "matroska"] : [])],
  };
}

function singleAudioReferenceRecipe(input, sourceAudioIndex) {
  const sourceExt = path.extname(input).toLowerCase();
  const extension = [".mp4", ".mov", ".m4a"].includes(sourceExt) ? sourceExt : ".mkv";
  const container = extension === ".mkv" ? "matroska" : extension === ".mov" ? "mov" : "mp4";
  return { extension,
    recipe: { kind: "single-audio-source", sourceAudioIndex, codec: "copy", container,
      copyts: true, avoid_negative_ts: "disabled" },
    args: ["-hide_banner", "-nostats", "-nostdin", "-y", "-copyts", "-i", input,
      "-map", `0:a:${sourceAudioIndex}`, "-vn", "-sn", "-dn", "-c:a", "copy",
      "-avoid_negative_ts", "disabled", "-f", container] };
}

module.exports = { stereoReferenceRecipe, singleAudioReferenceRecipe };
