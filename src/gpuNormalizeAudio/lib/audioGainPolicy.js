"use strict";

const { renderShellCommand } = require("./commandRenderer");
const { privateAacMovieArgs } = require("./outputAudioSpecs");

// Max Gain suppresses normalization, not the explicitly requested stereo track.
// The f64/192k stereo preparation is the same declared reference transformation;
// no loudnorm filter or reference output is used to produce this file.
function gainSkippedStereoCommand(args, plan, audioBitrate) {
  if (!plan.stereoFallback || plan.channels !== 2 || plan.sourceInput !== args.inputFileObj._id
      || !Number.isInteger(plan.sourceAudioIdx) || plan.sourceAudioIdx < 0
      || String(audioBitrate).toLowerCase() !== "192k") throw Error("Invalid gain-skipped stereo plan");
  return renderShellCommand([args.ffmpegPath, "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
    "-i", plan.sourceInput, "-map", `0:a:${plan.sourceAudioIdx}`, "-vn", "-sn", "-dn",
    "-af", "aformat=sample_fmts=dbl:sample_rates=192000:channel_layouts=stereo",
    "-c:a", "aac", "-b:a", audioBitrate, ...privateAacMovieArgs(plan.normalizedAudio), plan.normalizedAudio]);
}

module.exports = { gainSkippedStereoCommand };
