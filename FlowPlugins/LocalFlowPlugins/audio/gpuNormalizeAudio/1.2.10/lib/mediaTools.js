"use strict";

function mediaTools(args) {
  const tools = { ffmpeg: args.ffmpegPath || "ffmpeg",
    ffprobe: args.ffprobePath || args.inputs?.ffprobePath || process.env.FFPROBE || "ffprobe" };
  if (Object.values(tools).some(value => typeof value !== "string" || !value.trim() || value.includes("\0"))) {
    throw Error("Media executable paths must name individual executables");
  }
  return tools;
}

module.exports = { mediaTools };
