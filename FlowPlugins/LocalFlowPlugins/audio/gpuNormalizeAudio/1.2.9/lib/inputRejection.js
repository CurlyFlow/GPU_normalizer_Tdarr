"use strict";

const { boolInput } = require("./common");

function rejectInput(args, reason, selectedLanguages = []) {
  const removeFromTdarr = boolInput(args.inputs.removeRejectedFromTdarr, false);
  const messages = {
    noAudioStreams: "input has no audio streams",
    noSelectedAudio: `no audio would remain after selecting languages: ${selectedLanguages.join(", ")}`,
    belowMinimum: "input is below the configured minimum file size",
    aboveMaximum: "input exceeds the configured maximum file size",
    unreadableMedia: "FFmpeg cannot read the input after a stream-copy repair attempt",
  };
  const message = messages[reason];
  if (!message) throw new Error("Unknown input rejection reason");
  args.variables = {
    ...args.variables,
    removeFromTdarr,
    gpuNormalizeAudioRejection: {
      reason,
      inputFileId: args.inputFileObj._id,
      selectedLanguages: [...selectedLanguages],
    },
  };
  args.jobLog(`GPU Normalize Audio rejected input: ${message}. Using rejection output 2; ${removeFromTdarr ? "removing the entry from Tdarr when this flow ends" : "leaving terminal removal to the connected rejection handler"}.`);
  return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
}

module.exports = { rejectInput };
